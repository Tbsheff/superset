import { db } from "@superset/db/client";
import {
	githubInstallations,
	githubPullRequests,
	githubRepositories,
} from "@superset/db/schema";
import { subDays } from "date-fns";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { githubApp } from "../../octokit";

const payloadSchema = z.object({
	installationDbId: z.string().uuid(),
});

export async function POST(request: Request) {
	if (!githubApp) {
		return Response.json(
			{ error: "GitHub App not configured" },
			{ status: 503 },
		);
	}

	const body = await request.text();

	let bodyData: unknown;
	try {
		bodyData = JSON.parse(body);
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const parsed = payloadSchema.safeParse(bodyData);
	if (!parsed.success) {
		return Response.json({ error: "Invalid payload" }, { status: 400 });
	}

	const { installationDbId } = parsed.data;

	try {
		await performGitHubInitialSync(installationDbId);
		return Response.json({ success: true });
	} catch (error) {
		console.error("[github/initial-sync] Sync failed:", error);
		return Response.json(
			{ error: error instanceof Error ? error.message : "Sync failed" },
			{ status: 500 },
		);
	}
}

export async function performGitHubInitialSync(
	installationDbId: string,
) {
	if (!githubApp) {
		throw new Error("GitHub App not configured");
	}

	const [installation] = await db
		.select()
		.from(githubInstallations)
		.where(eq(githubInstallations.id, installationDbId))
		.limit(1);

	if (!installation) {
		throw new Error("Installation not found");
	}

	const octokit = await githubApp.getInstallationOctokit(
		Number(installation.installationId),
	);

	const repos = await octokit.paginate(
		octokit.rest.apps.listReposAccessibleToInstallation,
		{ per_page: 100 },
	);

	console.log(`[github/initial-sync] Found ${repos.length} repositories`);

	for (const repo of repos) {
		await db
			.insert(githubRepositories)
			.values({
				installationId: installationDbId,
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

	const thirtyDaysAgo = subDays(new Date(), 30);

	for (const repo of repos) {
		const [dbRepo] = await db
			.select()
			.from(githubRepositories)
			.where(eq(githubRepositories.repoId, String(repo.id)))
			.limit(1);

		if (!dbRepo) continue;

		const prs: Awaited<ReturnType<typeof octokit.rest.pulls.list>>["data"] = [];

		for await (const response of octokit.paginate.iterator(
			octokit.rest.pulls.list,
			{
				owner: repo.owner.login,
				repo: repo.name,
				state: "all",
				sort: "updated",
				direction: "desc",
				per_page: 100,
			},
		)) {
			let reachedCutoff = false;
			for (const pr of response.data) {
				if (new Date(pr.updated_at) < thirtyDaysAgo) {
					reachedCutoff = true;
					break;
				}
				prs.push(pr);
			}
			if (reachedCutoff) break;
		}

		console.log(
			`[github/initial-sync] Found ${prs.length} PRs (last 30 days) for ${repo.full_name}`,
		);

		for (const pr of prs) {
			const { data: checksData } = await octokit.rest.checks.listForRef({
				owner: repo.owner.login,
				repo: repo.name,
				ref: pr.head.sha,
			});

			const checks = checksData.check_runs.map(
				(c: (typeof checksData.check_runs)[number]) => ({
					name: c.name,
					status: c.status,
					conclusion: c.conclusion,
					detailsUrl: c.details_url ?? undefined,
				}),
			);

			let checksStatus = "none";
			if (checks.length > 0) {
				const hasFailure = checks.some(
					(c: {
						name: string;
						status: string;
						conclusion: string | null;
						detailsUrl?: string;
					}) => c.conclusion === "failure" || c.conclusion === "timed_out",
				);
				const hasPending = checks.some(
					(c: {
						name: string;
						status: string;
						conclusion: string | null;
						detailsUrl?: string;
					}) => c.status !== "completed",
				);

				checksStatus = hasFailure
					? "failure"
					: hasPending
						? "pending"
						: "success";
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
		}
	}

	await db
		.update(githubInstallations)
		.set({ lastSyncedAt: new Date() })
		.where(eq(githubInstallations.id, installationDbId));

	console.log("[github/initial-sync] Sync completed successfully");
}
