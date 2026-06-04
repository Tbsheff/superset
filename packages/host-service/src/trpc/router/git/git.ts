import { rm } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { pullRequests, workspaces } from "../../../db/schema";
import { buildRemoteRuntimeResolver } from "../../../runtime/exec";
import { collectFileDiff } from "../../../runtime/git/diff-collector";
import {
	createTempWorktreeProvider,
	exportAndPushRemote,
	pushRemotePatch as pushRemotePatchHost,
	type RepoLookup,
} from "../../../runtime/git/push-remote-patch";
import { isRuntimeProviderError } from "../../../runtime/seam";
import { protectedProcedure, queryProcedure, router } from "../../index";
import { resolveGithubRepo } from "../workspace-creation/shared/project-helpers";
import type {
	CheckConclusionState,
	CheckRun,
	CheckStatusState,
	Commit,
	IssueComment,
	MergeableState,
	PullRequestReviewDecision,
	PullRequestReviewThread,
	PullRequestState,
} from "./types";
import { gitConfigWrite } from "./utils/config-write";
import { getChangedFilesForDiff } from "./utils/git-helpers";
import {
	getDefaultBranchNameViaRunner,
	getGitStatusSnapshotRemote,
	parsePorcelainStatus,
	resolveBaseComparisonViaRunner,
} from "./utils/git-remote-status";
import { resolveGitRunner } from "./utils/git-runner";
import { getGitStatusSnapshot } from "./utils/git-status";
import { gitStatusRefreshLimiter } from "./utils/git-status-refresh-limiter";
import {
	type GraphQLThreadsResult,
	parseGraphQLThreads,
	REVIEW_THREADS_QUERY,
} from "./utils/graphql";
import { resolveWorktreePath } from "./utils/resolve-worktree";

/** Single-quote a path for the remote `runtime.exec` shell arm. */
function shellQuoteArg(arg: string): string {
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

function assertSafeRelativePath(filePath: string): void {
	if (isAbsolute(filePath)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Absolute paths are not allowed",
		});
	}
	const normalized = normalize(filePath);
	if (normalized.split(sep).includes("..")) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path traversal is not allowed",
		});
	}
	if (normalized === "" || normalized === ".") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Cannot target worktree root",
		});
	}
}

export const gitRouter = router({
	listBranches: queryProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);

			// `%(HEAD)` emits "*" for the checked-out branch, " " otherwise.
			// Single spawn — independent of branch count. Only `name`/`isHead`
			// are read by the v2 sidebar's BaseBranchSelector; the other
			// per-branch fields the previous implementation computed (upstream,
			// ahead/behind, last-commit) cost 4 spawns each and were unused.
			let branches: { name: string; isHead: boolean }[] = [];
			try {
				const raw = await runner.raw([
					"for-each-ref",
					"refs/heads/",
					"--format=%(HEAD)\t%(refname:short)",
				]);
				branches = raw
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const tab = line.indexOf("\t");
						if (tab < 0) return { name: line, isHead: false };
						return {
							isHead: line.slice(0, tab) === "*",
							name: line.slice(tab + 1),
						};
					});
			} catch {}

			return { branches };
		}),

	getStatus: queryProcedure
		.meta({ timeoutMs: 15_000 })
		.input(
			z.object({
				workspaceId: z.string(),
				baseBranch: z.string().optional(),
				priority: z.enum(["foreground", "background"]).optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const requestKey = JSON.stringify({
				baseBranch: input.baseBranch ?? null,
			});
			return gitStatusRefreshLimiter.run({
				workspaceId: input.workspaceId,
				requestKey,
				priority: input.priority,
				run: async () => {
					const resolved = await resolveGitRunner(ctx, input.workspaceId);
					if (resolved.workspace.runtimeKind === "remote") {
						return getGitStatusSnapshotRemote({
							runner: resolved.runner,
							baseBranch: input.baseBranch,
						});
					}
					const worktreePath = resolveWorktreePath(ctx, input.workspaceId);
					const git = await ctx.git(worktreePath);
					return getGitStatusSnapshot({
						git,
						worktreePath,
						baseBranch: input.baseBranch,
					});
				},
			});
		}),

	listCommits: queryProcedure
		.meta({ timeoutMs: 30_000 })
		.input(
			z.object({
				workspaceId: z.string(),
				baseBranch: z.string().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);

			const base = await resolveBaseComparisonViaRunner(
				runner,
				input.baseBranch,
			);
			const baseRef = base?.baseRef ?? "HEAD";

			const commits: Commit[] = [];
			try {
				const raw = await runner.raw([
					"log",
					`${baseRef}..HEAD`,
					"--format=%H\t%h\t%s\t%an\t%aI",
				]);
				for (const line of raw.trim().split("\n")) {
					if (!line) continue;
					const [hash, shortHash, message, author, date] = line.split("\t");
					commits.push({
						hash: hash ?? "",
						shortHash: shortHash ?? "",
						message: message ?? "",
						author: author ?? "",
						date: date ?? "",
					});
				}
			} catch {}

			return { commits };
		}),

	getCommitFiles: queryProcedure
		.meta({ timeoutMs: 15_000 })
		.input(
			z.object({
				workspaceId: z.string(),
				commitHash: z.string(),
				fromHash: z.string().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);

			const from = input.fromHash ? input.fromHash : `${input.commitHash}^`;
			const files = await getChangedFilesForDiff(runner, [
				from,
				input.commitHash,
			]);

			return { files };
		}),

	getBaseBranch: queryProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);
			const currentBranch = (
				await runner.raw(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
			).trim();
			if (!currentBranch || currentBranch === "HEAD") {
				return { baseBranch: null as string | null };
			}
			const configured = (
				await runner
					.raw(["config", `branch.${currentBranch}.base`])
					.catch(() => "")
			).trim();
			return { baseBranch: (configured || null) as string | null };
		}),

	setBaseBranch: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				baseBranch: z.string().nullable(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);
			const currentBranch = (
				await runner.raw(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
			).trim();
			if (!currentBranch || currentBranch === "HEAD") {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Cannot set base branch on detached HEAD",
				});
			}
			if (input.baseBranch) {
				await gitConfigWrite(runner, [
					"config",
					`branch.${currentBranch}.base`,
					input.baseBranch,
				]);
			} else {
				await gitConfigWrite(runner, [
					"config",
					"--unset",
					`branch.${currentBranch}.base`,
				]).catch(() => {});
			}
			return { baseBranch: input.baseBranch };
		}),

	renameBranch: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				oldName: z.string(),
				newName: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);

			// Check if branch has been pushed to remote
			try {
				const remote = await runner.raw([
					"ls-remote",
					"--heads",
					"origin",
					input.oldName,
				]);
				if (remote.trim()) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "Cannot rename a branch that has been pushed to remote",
					});
				}
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				// ls-remote failed — probably no remote, safe to rename
			}

			await runner.raw(["branch", "-m", input.oldName, input.newName]);
			return { name: input.newName };
		}),

	discardChanges: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				filePath: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			assertSafeRelativePath(input.filePath);
			const { runner, workspace } = await resolveGitRunner(
				ctx,
				input.workspaceId,
			);

			if (workspace.runtimeKind === "remote") {
				const statusRaw = await runner
					.raw(["status", "--porcelain=v1", "-z"])
					.catch(() => "");
				const isUntracked = parsePorcelainStatus(statusRaw).some(
					(f) =>
						f.path === input.filePath &&
						f.index === "?" &&
						f.working_dir === "?",
				);
				if (isUntracked) {
					await runner.execShell?.(`rm -f -- ${shellQuoteArg(input.filePath)}`);
				} else {
					await runner.raw(["checkout", "HEAD", "--", input.filePath]);
				}
				return { success: true };
			}

			const worktreePath = resolveWorktreePath(ctx, input.workspaceId);
			const git = await ctx.git(worktreePath);
			const status = await git.status();
			const isUntracked = status.not_added.includes(input.filePath);
			if (isUntracked) {
				await rm(join(worktreePath, input.filePath), { force: true });
			} else {
				await git.raw(["checkout", "HEAD", "--", input.filePath]);
			}
			return { success: true };
		}),

	discardAllUnstaged: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);
			await runner.raw(["checkout", "--", "."]);
			await runner.raw(["clean", "-fd"]);
			return { success: true };
		}),

	discardAllStaged: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const { runner, workspace } = await resolveGitRunner(
				ctx,
				input.workspaceId,
			);

			// Files with a staged change (index entry differs from HEAD). For
			// remote, parse `git status --porcelain` for the same `{index, path,
			// from}` shape `git.status().files` provides locally.
			let stagedFiles: { index: string; path: string; from?: string }[];
			if (workspace.runtimeKind === "remote") {
				const statusRaw = await runner
					.raw(["status", "--porcelain=v1", "-z"])
					.catch(() => "");
				stagedFiles = parsePorcelainStatus(statusRaw).filter(
					(f) => f.index !== " " && f.index !== "?",
				);
			} else {
				const git = await ctx.git(resolveWorktreePath(ctx, input.workspaceId));
				const status = await git.status();
				stagedFiles = status.files.filter(
					(f) => f.index !== " " && f.index !== "?",
				);
			}

			const checkoutHeadPaths: string[] = [];
			const resetPaths: string[] = [];
			const deletePaths: string[] = [];

			for (const f of stagedFiles) {
				if (f.index === "A") {
					// Staged-as-added: not in HEAD. Unstage + delete.
					resetPaths.push(f.path);
					deletePaths.push(f.path);
				} else if (f.index === "R") {
					// Staged rename: index has both delete-of-old and add-of-new.
					// Unstage both ends, restore old from HEAD, delete new.
					resetPaths.push(f.path);
					deletePaths.push(f.path);
					if (f.from) {
						resetPaths.push(f.from);
						checkoutHeadPaths.push(f.from);
					}
				} else if (f.index === "C") {
					// Staged copy: source unchanged, dest is new in index.
					resetPaths.push(f.path);
					deletePaths.push(f.path);
				} else {
					// M, D, T: exists in HEAD; checkout reverts both index and WT.
					checkoutHeadPaths.push(f.path);
				}
			}

			if (resetPaths.length > 0) {
				await runner.raw(["reset", "HEAD", "--", ...resetPaths]);
			}
			if (checkoutHeadPaths.length > 0) {
				await runner.raw(["checkout", "HEAD", "--", ...checkoutHeadPaths]);
			}
			if (deletePaths.length > 0) {
				if (workspace.runtimeKind === "remote") {
					const args = deletePaths.map(shellQuoteArg).join(" ");
					await runner.execShell?.(`rm -f -- ${args}`);
				} else {
					const worktreePath = resolveWorktreePath(ctx, input.workspaceId);
					for (const filePath of deletePaths) {
						await rm(join(worktreePath, filePath), { force: true });
					}
				}
			}
			return { success: true };
		}),

	stageAll: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);
			await runner.raw(["add", "-A"]);
			return { success: true };
		}),

	unstageAll: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const { runner } = await resolveGitRunner(ctx, input.workspaceId);
			await runner.raw(["reset", "HEAD"]);
			return { success: true };
		}),

	getDiff: queryProcedure
		.meta({ timeoutMs: 30_000 })
		.input(
			z.object({
				workspaceId: z.string(),
				path: z.string(),
				category: z.enum(["against-base", "staged", "unstaged", "commit"]),
				baseBranch: z.string().optional(),
				commitHash: z.string().optional(),
				fromHash: z.string().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}

			// Remote (Daytona) workspaces have no local worktree; resolve the live
			// runtime and read per-file content in-sandbox instead of through the
			// host worktree path (which is "" and would throw NOT_FOUND).
			if (workspace.runtimeKind === "remote") {
				const resolver = await buildRemoteRuntimeResolver(ctx);
				const runtime = await resolver.resolve(input.workspaceId);
				if (!runtime.getFileContents) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"Remote runtime does not support per-file diffs on this host.",
					});
				}
				return runtime.getFileContents({
					path: input.path,
					category: input.category,
					baseBranch: input.baseBranch,
					commitHash: input.commitHash,
					fromHash: input.fromHash,
				});
			}

			const worktreePath = resolveWorktreePath(ctx, input.workspaceId);
			const git = await ctx.git(worktreePath);
			return collectFileDiff(git, {
				category: input.category,
				path: input.path,
				worktreePath,
				baseBranch: input.baseBranch,
				commitHash: input.commitHash,
				fromHash: input.fromHash,
			});
		}),

	getBranchSyncStatus: queryProcedure
		.meta({ timeoutMs: 30_000 })
		.input(z.object({ workspaceId: z.string() }))
		.query(async ({ ctx, input }) => {
			const { runner, workspace } = await resolveGitRunner(
				ctx,
				input.workspaceId,
			);
			const isRemote = workspace.runtimeKind === "remote";

			const currentBranch = (
				await runner.raw(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
			).trim();
			const isDetached = !currentBranch || currentBranch === "HEAD";

			const defaultBranch = await getDefaultBranchNameViaRunner(runner);
			const isDefaultBranch =
				!isDetached && !!defaultBranch && currentBranch === defaultBranch;

			// `git remote` lists configured remotes one per line — equivalent to
			// simple-git's `getRemotes(false)` for the "has any remote" check.
			const remotesRaw = await runner.raw(["remote"]).catch(() => "");
			const hasRepo = remotesRaw.split("\n").some((line) => line.trim());

			let hasUpstream = false;
			let pushCount = 0;
			let pullCount = 0;
			try {
				await runner.raw(["rev-parse", "--abbrev-ref", "@{upstream}"]);
				hasUpstream = true;
				const tracking = await runner.raw([
					"rev-list",
					"--left-right",
					"--count",
					"@{upstream}...HEAD",
				]);
				const [pullStr, pushStr] = tracking.trim().split(/\s+/);
				pullCount = Number.parseInt(pullStr || "0", 10);
				pushCount = Number.parseInt(pushStr || "0", 10);
			} catch {
				// no upstream — counts stay zero
			}

			// Read working-tree status separately from branch info so a transient
			// `git status` failure (e.g. lock contention during a concurrent
			// operation) doesn't poison the whole sync read. Log on failure so it
			// isn't silent — `hasUncommitted` defaults to false in that case
			// because over-reporting "uncommitted" on every blip is more annoying
			// than under-reporting briefly until the next refetch.
			let hasUncommitted = false;
			try {
				if (isRemote) {
					const statusRaw = await runner.raw([
						"status",
						"--porcelain=v1",
						"-z",
					]);
					hasUncommitted = parsePorcelainStatus(statusRaw).length > 0;
				} else {
					const git = await ctx.git(
						resolveWorktreePath(ctx, input.workspaceId),
					);
					const status = await git.status();
					hasUncommitted = status.files.length > 0;
				}
			} catch (error) {
				console.warn(
					"[git/getBranchSyncStatus] git.status() failed; treating working tree as clean for this read",
					error,
				);
			}

			return {
				hasRepo,
				hasUpstream,
				pushCount,
				pullCount,
				isDefaultBranch,
				isDetached,
				hasUncommitted,
				currentBranch: isDetached ? null : currentBranch,
				defaultBranch,
			};
		}),

	getPullRequest: queryProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(({ ctx, input }) => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}
			if (!workspace.pullRequestId) return null;

			const pr = ctx.db.query.pullRequests
				.findFirst({ where: eq(pullRequests.id, workspace.pullRequestId) })
				.sync();
			if (!pr) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Pull request ${workspace.pullRequestId} not found in database`,
				});
			}

			let checks: CheckRun[] = [];
			try {
				const parsed = JSON.parse(pr.checksJson);
				if (Array.isArray(parsed)) {
					checks = parsed.map(
						(c: Record<string, unknown>): CheckRun => ({
							name: (c.name as string) ?? "",
							status: ((c.status as string) ?? "completed") as CheckStatusState,
							conclusion: (c.conclusion ?? null) as CheckConclusionState | null,
							detailsUrl: (c.url as string) ?? null,
							startedAt: (c.startedAt as string) ?? null,
							completedAt: (c.completedAt as string) ?? null,
						}),
					);
				}
			} catch {}

			return {
				number: pr.prNumber,
				url: pr.url,
				title: pr.title,
				body: null as string | null,
				state: pr.state as PullRequestState,
				isDraft: pr.isDraft ?? false,
				reviewDecision: (pr.reviewDecision ??
					null) as PullRequestReviewDecision | null,
				mergeable: "unknown" as MergeableState,
				headRefName: pr.headBranch ?? "",
				updatedAt: pr.updatedAt ? new Date(pr.updatedAt).toISOString() : "",
				checks,
				repoOwner: pr.repoOwner,
				repoName: pr.repoName,
			};
		}),

	getPullRequestThreads: queryProcedure
		.meta({ timeoutMs: 30_000 })
		.input(z.object({ workspaceId: z.string() }))
		.query(async ({ ctx, input }) => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}
			if (!workspace.pullRequestId) {
				return { reviewThreads: [], conversationComments: [] };
			}

			const pr = ctx.db.query.pullRequests
				.findFirst({ where: eq(pullRequests.id, workspace.pullRequestId) })
				.sync();
			if (!pr) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Pull request ${workspace.pullRequestId} not found in database`,
				});
			}

			let repo: { owner: string; name: string };
			try {
				repo = await resolveGithubRepo(ctx, workspace.projectId);
			} catch (err) {
				// Expected resolver failures (project not set up locally, no
				// GitHub remote) degrade silently — the review tab just stays
				// empty. Anything else is a real bug; propagate it.
				if (err instanceof TRPCError) {
					return { reviewThreads: [], conversationComments: [] };
				}
				throw err;
			}

			const octokit = await ctx.github();

			let reviewThreads: PullRequestReviewThread[] = [];
			try {
				const result: GraphQLThreadsResult = await octokit.graphql(
					REVIEW_THREADS_QUERY,
					{
						owner: repo.owner,
						name: repo.name,
						prNumber: pr.prNumber,
					},
				);
				reviewThreads = parseGraphQLThreads(result);
			} catch (error) {
				console.warn(
					"[git.getPullRequestThreads] Failed to fetch review threads:",
					error,
				);
			}

			const conversationComments: IssueComment[] = [];
			try {
				let page = 1;
				let hasMore = true;
				while (hasMore) {
					const { data: comments } = await octokit.issues.listComments({
						owner: repo.owner,
						repo: repo.name,
						issue_number: pr.prNumber,
						per_page: 100,
						page,
					});
					for (const c of comments) {
						const body = c.body?.trim();
						if (!body) continue;
						conversationComments.push({
							id: c.id,
							user: {
								login: c.user?.login ?? "ghost",
								avatarUrl: c.user?.avatar_url ?? "",
							},
							body,
							createdAt: c.created_at ?? "",
							htmlUrl: c.html_url ?? "",
						});
					}
					hasMore = comments.length === 100;
					page++;
				}
			} catch (error) {
				console.warn(
					"[git.getPullRequestThreads] Failed to fetch conversation comments:",
					error,
				);
			}

			return { reviewThreads, conversationComments };
		}),

	setReviewThreadResolution: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				threadId: z.string(),
				resolved: z.boolean(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}

			const octokit = await ctx.github();
			const mutation = input.resolved
				? `mutation($threadId: ID!) {
					resolveReviewThread(input: {threadId: $threadId}) {
						thread { id isResolved }
					}
				}`
				: `mutation($threadId: ID!) {
					unresolveReviewThread(input: {threadId: $threadId}) {
						thread { id isResolved }
					}
				}`;

			try {
				await octokit.graphql(mutation, { threadId: input.threadId });
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "GraphQL mutation failed";
				throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
			}

			return { threadId: input.threadId, isResolved: input.resolved };
		}),

	/**
	 * Host-side apply + push for a REMOTE (Daytona) workspace. The sandbox runs
	 * with no broad token; it exports a working-tree patch (`exportPatch()`),
	 * the renderer/main hands it here, and the host applies it into the real
	 * worktree and pushes with a single-repo-scoped token that never enters the
	 * sandbox. Includes a SAME-REPO / NON-FORK guard: a repo-scoped token can
	 * only push to the one repo it owns, so a fork (or an unwritable repo) is
	 * refused before any token is minted.
	 */
	pushRemotePatch: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				/** Base64-encoded patch bytes from `exportPatch()` (binary-safe). */
				patchBase64: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.mintRepoScopedToken) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Remote-runtime push is not configured on this host (no scoped-token minter).",
				});
			}

			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}

			const repo = await resolveGithubRepo(ctx, workspace.projectId);
			const patch = Buffer.from(input.patchBase64, "base64");
			const pushDeps = {
				git: ctx.git,
				octokit: (await ctx.github()) as unknown as RepoLookup,
				mintRepoScopedToken: ctx.mintRepoScopedToken,
			};

			try {
				// Remote (Daytona) workspaces have no host worktree (`worktree_path`
				// is the "" sentinel): apply + push through a throwaway worktree
				// forked from the project's local clone. Local workspaces push their
				// existing worktree directly.
				if (workspace.runtimeKind === "remote") {
					const worktreeProvider = createTempWorktreeProvider({
						git: ctx.git,
						repoPath: repo.repoPath,
					});
					const { worktreePath } = await worktreeProvider.acquire({
						branch: workspace.branch,
					});
					try {
						return await pushRemotePatchHost(pushDeps, {
							worktreePath,
							branch: workspace.branch,
							repo: { owner: repo.owner, repo: repo.name },
							patch,
						});
					} finally {
						await worktreeProvider.release(worktreePath).catch(() => {});
					}
				}

				if (!workspace.worktreePath) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "Workspace has no local worktree to push from.",
					});
				}

				return await pushRemotePatchHost(pushDeps, {
					worktreePath: workspace.worktreePath,
					branch: workspace.branch,
					repo: { owner: repo.owner, repo: repo.name },
					patch,
				});
			} catch (error) {
				if (isRuntimeProviderError(error) && error.code === "CROSS_REPO_PUSH") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: error.message,
					});
				}
				throw error;
			}
		}),

	/**
	 * End-to-end export-and-push for a REMOTE (Daytona) workspace: collects the
	 * patch INSIDE the runtime (`exportPatch()`), then applies + pushes it
	 * host-side with a single-repo-scoped token that never enters the sandbox.
	 * This is the one procedure the desktop drives to ship work out of a remote
	 * workspace; `pushRemotePatch` above stays as the lower-level "patch already
	 * in hand" entry point.
	 */
	exportAndPushRemote: protectedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			if (!ctx.mintRepoScopedToken) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Remote-runtime push is not configured on this host (no scoped-token minter).",
				});
			}

			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();
			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}
			if (workspace.runtimeKind !== "remote") {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"exportAndPushRemote only applies to remote workspaces; local workspaces push their own worktree.",
				});
			}

			const repo = await resolveGithubRepo(ctx, workspace.projectId);

			try {
				return await exportAndPushRemote({
					workspaceId: input.workspaceId,
					branch: workspace.branch,
					repo: { owner: repo.owner, repo: repo.name },
					resolver: await buildRemoteRuntimeResolver(ctx),
					worktreeProvider: createTempWorktreeProvider({
						git: ctx.git,
						repoPath: repo.repoPath,
					}),
					push: {
						git: ctx.git,
						octokit: (await ctx.github()) as unknown as RepoLookup,
						mintRepoScopedToken: ctx.mintRepoScopedToken,
					},
				});
			} catch (error) {
				if (isRuntimeProviderError(error) && error.code === "CROSS_REPO_PUSH") {
					throw new TRPCError({ code: "FORBIDDEN", message: error.message });
				}
				throw error;
			}
		}),
});
