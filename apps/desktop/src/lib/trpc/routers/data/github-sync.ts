import { db } from "@superset/db/client";
import {
	githubInstallations,
	githubPullRequests,
	githubRepositories,
} from "@superset/db/schema";
import { LOCAL_USER_ID } from "@superset/shared/constants";
import { eq } from "drizzle-orm";
import { execWithShellEnv } from "../../routers/workspaces/utils/shell-env";

// ---------------------------------------------------------------------------
// gh auth helpers
// ---------------------------------------------------------------------------

interface GhAuthStatus {
	authenticated: boolean;
	username?: string;
}

export async function isGhAuthenticated(): Promise<GhAuthStatus> {
	try {
		const { stdout } = await execWithShellEnv("gh", [
			"auth",
			"status",
			"--active",
		]);
		// gh auth status prints "Logged in to github.com account <user> ..."
		const match = /account\s+(\S+)/.exec(stdout);
		return {
			authenticated: true,
			username: match?.[1] ?? undefined,
		};
	} catch (error) {
		// gh auth status exits non-zero when not authenticated
		// but prints to stderr — check if the error output mentions "Logged in"
		if (error instanceof Error && "stderr" in error) {
			const stderr = (error as { stderr: string }).stderr ?? "";
			const match = /account\s+(\S+)/.exec(stderr);
			if (match) {
				return { authenticated: true, username: match[1] };
			}
		}
		return { authenticated: false };
	}
}

// ---------------------------------------------------------------------------
// gh api JSON types
// ---------------------------------------------------------------------------

interface GhRepo {
	id: number;
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	default_branch: string;
}

interface GhPR {
	number: number;
	node_id: string;
	title: string;
	html_url: string;
	state: string;
	draft: boolean;
	head: { ref: string; sha: string };
	base: { ref: string };
	user: { login: string; avatar_url: string } | null;
	merged_at: string | null;
	closed_at: string | null;
	updated_at: string;
}

interface GhCheckRun {
	name: string;
	status: string;
	conclusion: string | null;
	details_url: string | null;
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

async function ghApi<T>(endpoint: string): Promise<T> {
	const { stdout } = await execWithShellEnv("gh", ["api", endpoint], {
		maxBuffer: MAX_BUFFER,
	});
	return JSON.parse(stdout) as T;
}

async function ensureInstallation(username: string): Promise<string> {
	const existing = await db.query.githubInstallations.findFirst({
		columns: { id: true },
	});
	if (existing) return existing.id;

	const [row] = await db
		.insert(githubInstallations)
		.values({
			connectedByUserId: LOCAL_USER_ID,
			installationId: `gh-cli-${username}`,
			accountLogin: username,
			accountType: "User",
		})
		.onConflictDoUpdate({
			target: [githubInstallations.installationId],
			set: {
				accountLogin: username,
				updatedAt: new Date(),
			},
		})
		.returning({ id: githubInstallations.id });

	if (!row) throw new Error("Failed to create GitHub installation");
	return row.id;
}

export async function performGitHubSync(): Promise<{
	repoCount: number;
	prCount: number;
}> {
	const { authenticated, username } = await isGhAuthenticated();
	if (!authenticated || !username) {
		return { repoCount: 0, prCount: 0 };
	}

	const installationId = await ensureInstallation(username);

	// Fetch repos (user's repos, sorted by most recently pushed)
	const repos = await ghApi<GhRepo[]>(
		"user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
	);

	// Upsert repos
	for (const repo of repos) {
		await db
			.insert(githubRepositories)
			.values({
				installationId,
				repoId: String(repo.id),
				owner: repo.owner.login,
				name: repo.name,
				fullName: repo.full_name,
				defaultBranch: repo.default_branch ?? "main",
				isPrivate: repo.private,
			})
			.onConflictDoUpdate({
				target: [githubRepositories.repoId],
				set: {
					owner: repo.owner.login,
					name: repo.name,
					fullName: repo.full_name,
					defaultBranch: repo.default_branch ?? "main",
					isPrivate: repo.private,
					updatedAt: new Date(),
				},
			});
	}

	// Fetch PRs for each repo (last 30 days, all states)
	const thirtyDaysAgo = new Date();
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
	let totalPrCount = 0;

	for (const repo of repos) {
		const [dbRepo] = await db
			.select({ id: githubRepositories.id })
			.from(githubRepositories)
			.where(eq(githubRepositories.repoId, String(repo.id)))
			.limit(1);
		if (!dbRepo) continue;

		let prs: GhPR[];
		try {
			prs = await ghApi<GhPR[]>(
				`repos/${repo.full_name}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
			);
		} catch {
			continue;
		}

		// Filter to last 30 days
		prs = prs.filter((pr) => new Date(pr.updated_at) >= thirtyDaysAgo);

		for (const pr of prs) {
			// Fetch check runs for the PR head SHA
			let checks: Array<{
				name: string;
				status: string;
				conclusion: string | null;
				detailsUrl?: string;
			}> = [];
			let checksStatus = "none";

			try {
				const checksData = await ghApi<{ check_runs: GhCheckRun[] }>(
					`repos/${repo.full_name}/commits/${pr.head.sha}/check-runs`,
				);
				checks = checksData.check_runs.map((c) => ({
					name: c.name,
					status: c.status,
					conclusion: c.conclusion,
					detailsUrl: c.details_url ?? undefined,
				}));

				if (checks.length > 0) {
					const hasFailure = checks.some(
						(c) => c.conclusion === "failure" || c.conclusion === "timed_out",
					);
					const hasPending = checks.some((c) => c.status !== "completed");
					checksStatus = hasFailure
						? "failure"
						: hasPending
							? "pending"
							: "success";
				}
			} catch {
				// Check runs may fail for some repos (permissions), continue
			}

			await db
				.insert(githubPullRequests)
				.values({
					repositoryId: dbRepo.id,
					prNumber: pr.number,
					nodeId: pr.node_id,
					headBranch: pr.head.ref,
					headSha: pr.head.sha,
					baseBranch: pr.base.ref,
					title: pr.title,
					url: pr.html_url,
					authorLogin: pr.user?.login ?? "unknown",
					authorAvatarUrl: pr.user?.avatar_url ?? null,
					state: pr.state,
					isDraft: pr.draft ?? false,
					additions: 0,
					deletions: 0,
					changedFiles: 0,
					reviewDecision: null,
					checksStatus,
					checks,
					mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
					closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
				})
				.onConflictDoUpdate({
					target: [
						githubPullRequests.repositoryId,
						githubPullRequests.prNumber,
					],
					set: {
						headSha: pr.head.sha,
						title: pr.title,
						state: pr.state,
						isDraft: pr.draft ?? false,
						checksStatus,
						checks,
						mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
						closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
						lastSyncedAt: new Date(),
						updatedAt: new Date(),
					},
				});

			totalPrCount++;
		}
	}

	// Update installation lastSyncedAt
	await db
		.update(githubInstallations)
		.set({ lastSyncedAt: new Date() })
		.where(eq(githubInstallations.id, installationId));

	return { repoCount: repos.length, prCount: totalPrCount };
}
