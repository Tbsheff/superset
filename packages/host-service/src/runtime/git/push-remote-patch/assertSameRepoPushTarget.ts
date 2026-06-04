import type { RepoCoordinates } from "../../adapters/daytona/types.ts";
import { RuntimeProviderError } from "../../seam/index.ts";

/**
 * The minimal octokit surface the guard needs. A `Pick`-style structural type
 * (rather than the whole `Octokit`) keeps the unit test honest: the fake only
 * models the one call the guard makes.
 */
export interface RepoLookup {
	repos: {
		get(args: { owner: string; repo: string }): Promise<{
			data: {
				fork: boolean;
				permissions?: { push?: boolean } | null;
			};
		}>;
	};
}

/**
 * SAME-REPO / NON-FORK guard for the host-side push. A repo-scoped installation
 * token can only push to the ONE repo it was minted for; pushing a fork's
 * branch to its upstream (or to a repo the caller can't write) would silently
 * fail or hit the wrong target. Refuse both cases up front with a typed
 * `CROSS_REPO_PUSH` error so the caller can branch on the cause.
 *
 *   - `data.fork === true`  -> the target is a fork; fork-push is out of scope.
 *   - `permissions.push` falsy -> the caller/installation cannot write here.
 */
export async function assertSameRepoPushTarget(
	octokit: RepoLookup,
	coords: RepoCoordinates,
): Promise<void> {
	let data: { fork: boolean; permissions?: { push?: boolean } | null };
	try {
		({ data } = await octokit.repos.get({
			owner: coords.owner,
			repo: coords.repo,
		}));
	} catch (error) {
		throw new RuntimeProviderError(
			"CROSS_REPO_PUSH",
			`Cannot verify push target ${coords.owner}/${coords.repo}: ${
				error instanceof Error ? error.message : "repo lookup failed"
			}`,
		);
	}

	if (data.fork) {
		throw new RuntimeProviderError(
			"CROSS_REPO_PUSH",
			`Refusing to push: ${coords.owner}/${coords.repo} is a fork. Remote-runtime push only targets the upstream repository the scoped token owns.`,
		);
	}

	if (!data.permissions?.push) {
		throw new RuntimeProviderError(
			"CROSS_REPO_PUSH",
			`Refusing to push: no write access to ${coords.owner}/${coords.repo}.`,
		);
	}
}
