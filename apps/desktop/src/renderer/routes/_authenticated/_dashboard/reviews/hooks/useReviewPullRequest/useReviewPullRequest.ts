import type {
	SelectGithubPullRequest,
	SelectGithubRepository,
} from "@superset/db/schema";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";

export interface ReviewPullRequestDetail {
	pr: SelectGithubPullRequest;
	repository: SelectGithubRepository | null;
}

/**
 * Reads a single synced PR (+ its repository) from the local collection by id.
 * Cache-first: the row is served from local SQLite instantly; `isReady` only
 * disambiguates "still hydrating" from "genuinely absent" when no row is found.
 */
export function useReviewPullRequest(prId: string): {
	data: ReviewPullRequestDetail | null;
	isReady: boolean;
} {
	const collections = useCollections();

	const { data: prRows = [], isReady } = useLiveQuery(
		(q) =>
			q
				.from({ pr: collections.githubPullRequests })
				.where(({ pr }) => eq(pr.id, prId))
				.select(({ pr }) => ({ ...pr })),
		[collections, prId],
	);

	const { data: repoRows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ repo: collections.githubRepositories })
				.select(({ repo }) => ({ ...repo })),
		[collections],
	);

	return useMemo(() => {
		const pr = prRows[0] ?? null;
		if (!pr) return { data: null, isReady };
		const repository =
			repoRows.find((repo) => repo.id === pr.repositoryId) ?? null;
		return { data: { pr, repository }, isReady };
	}, [prRows, repoRows, isReady]);
}
