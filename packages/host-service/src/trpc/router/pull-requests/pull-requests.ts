import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaces } from "../../../db/schema";
import { buildRemoteRuntimeResolver } from "../../../runtime/exec";
import {
	createTempWorktreeProvider,
	exportAndPushRemote,
	type RepoLookup,
} from "../../../runtime/git/push-remote-patch";
import { isRuntimeProviderError } from "../../../runtime/seam";
import { protectedProcedure, router } from "../../index";
import { resolveGithubRepo } from "../workspace-creation/shared/project-helpers";
import { getContent } from "./procedures/get-content";

export const pullRequestsRouter = router({
	getByWorkspaces: protectedProcedure
		.input(
			z.object({
				workspaceIds: z.array(z.string()),
			}),
		)
		.query(async ({ ctx, input }) => {
			const workspaces =
				await ctx.runtime.pullRequests.getPullRequestsByWorkspaces(
					input.workspaceIds,
				);
			return { workspaces };
		}),
	refreshByWorkspaces: protectedProcedure
		.input(
			z.object({
				workspaceIds: z.array(z.string()),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await ctx.runtime.pullRequests.refreshPullRequestsByWorkspaces(
				input.workspaceIds,
			);
			return { ok: true };
		}),
	/**
	 * Publish-and-open a PR for a REMOTE (Daytona) workspace in one host-side
	 * call. The agent-driven `/pr/create-pr` flow runs `git push` + `gh pr create`
	 * in `cwd=worktree`, which is the `""` sentinel for a remote workspace, so it
	 * has no path to ship. Here the host pushes the branch via
	 * `exportAndPushRemote` (patch collected in-sandbox, applied + pushed from a
	 * throwaway host worktree with a single-repo-scoped token), then opens the PR
	 * with the host octokit — the scoped token can only push, not open PRs.
	 */
	publishAndCreatePR: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				title: z.string().optional(),
				body: z.string().optional(),
				base: z.string().optional(),
				draft: z.boolean().optional(),
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
			if (workspace.runtimeKind !== "remote") {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"publishAndCreatePR only applies to remote workspaces; local workspaces use the agent-driven flow.",
				});
			}

			const repo = await resolveGithubRepo(ctx, workspace.projectId);
			const octokit = await ctx.github();

			try {
				await exportAndPushRemote({
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
						octokit: octokit as unknown as RepoLookup,
						mintRepoScopedToken: ctx.mintRepoScopedToken,
					},
				});
			} catch (error) {
				if (isRuntimeProviderError(error) && error.code === "CROSS_REPO_PUSH") {
					throw new TRPCError({ code: "FORBIDDEN", message: error.message });
				}
				throw error;
			}

			// Default the PR base to the upstream repo's default branch when the
			// caller doesn't pin one; the pushed head is the workspace branch.
			const base =
				input.base?.trim() ||
				(await octokit.repos.get({ owner: repo.owner, repo: repo.name })).data
					.default_branch;

			const { data } = await octokit.pulls.create({
				owner: repo.owner,
				repo: repo.name,
				head: workspace.branch,
				base,
				title: input.title?.trim() || workspace.branch,
				body: input.body,
				draft: input.draft ?? false,
			});

			// Populate the PR row/badge now instead of waiting for the next remote
			// poll tick — the branch state just changed (new upstream).
			await ctx.runtime.pullRequests
				.syncRemoteWorkspace(input.workspaceId)
				.catch((err) => {
					console.warn(
						"[host-service:pull-requests] post-create remote sync failed",
						{ workspaceId: input.workspaceId, err },
					);
				});

			return { url: data.html_url, number: data.number };
		}),
	getContent,
});
