import type {
	SelectGithubPullRequest,
	SelectGithubRepository,
} from "@superset/db/schema";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	deriveReviewBucket,
	type ReviewBucket,
} from "../../utils/reviewStatus";
import { isMine, isNeedsMyReview } from "../../utils/triage";

export type ReviewTriageTab = "needs-review" | "mine" | "all";

export const REVIEW_TRIAGE_TABS: ReviewTriageTab[] = [
	"needs-review",
	"mine",
	"all",
];

export const REVIEW_TRIAGE_LABEL: Record<ReviewTriageTab, string> = {
	"needs-review": "Needs my review",
	mine: "My open PRs",
	all: "All open",
};

export type ReviewPullRequest = SelectGithubPullRequest & {
	repository: SelectGithubRepository | null;
	bucket: ReviewBucket;
};

interface UseReviewsDataParams {
	tab: ReviewTriageTab;
	viewerLogin: string | null;
	repoFilter: string | null;
	searchQuery: string;
}

interface UseReviewsDataResult {
	data: ReviewPullRequest[];
	repositories: SelectGithubRepository[];
	isReady: boolean;
	counts: Record<ReviewTriageTab, number>;
}

export function useReviewsData({
	tab,
	viewerLogin,
	repoFilter,
	searchQuery,
}: UseReviewsDataParams): UseReviewsDataResult {
	const collections = useCollections();

	const { data: prRows = [], isReady } = useLiveQuery(
		(q) =>
			q
				.from({ pr: collections.githubPullRequests })
				.select(({ pr }) => ({ ...pr })),
		[collections],
	);

	const { data: repoRows = [] } = useLiveQuery(
		(q) =>
			q
				.from({ repo: collections.githubRepositories })
				.select(({ repo }) => ({ ...repo })),
		[collections],
	);

	const me = viewerLogin?.toLowerCase() ?? null;

	// Enrich in JS rather than via a leftJoin: the join would type every repo
	// column as `| undefined`, and a Map lookup is cheaper than re-running the
	// join on every PR change.
	const repoById = useMemo(() => {
		const map = new Map<string, SelectGithubRepository>();
		for (const repo of repoRows) {
			map.set(repo.id, repo);
		}
		return map;
	}, [repoRows]);

	// Drop closed-unmerged PRs (review noise) but keep merged ones — a merge
	// surfaces as state="closed" with mergedAt set, and merged belongs on the board.
	const base = useMemo<ReviewPullRequest[]>(
		() =>
			prRows
				.filter((pr) => pr.state !== "closed" || pr.mergedAt != null)
				.map((pr) => ({
					...pr,
					repository: repoById.get(pr.repositoryId) ?? null,
					bucket: deriveReviewBucket(pr),
				})),
		[prRows, repoById],
	);

	const counts = useMemo<Record<ReviewTriageTab, number>>(
		() => ({
			"needs-review": base.filter((pr) => isNeedsMyReview(pr, me)).length,
			mine: base.filter((pr) => isMine(pr, me)).length,
			all: base.length,
		}),
		[base, me],
	);

	const data = useMemo<ReviewPullRequest[]>(() => {
		const query = searchQuery.trim().toLowerCase();
		return base
			.filter((pr) => {
				if (tab === "needs-review") return isNeedsMyReview(pr, me);
				if (tab === "mine") return isMine(pr, me);
				return true;
			})
			.filter((pr) => (repoFilter ? pr.repositoryId === repoFilter : true))
			.filter((pr) => {
				if (!query) return true;
				const haystack =
					`${pr.title} ${pr.authorLogin} ${pr.repository?.fullName ?? ""} #${pr.prNumber}`.toLowerCase();
				return haystack.includes(query);
			})
			.sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			);
	}, [base, tab, me, repoFilter, searchQuery]);

	const repositories = useMemo(
		() => [...repoRows].sort((a, b) => a.fullName.localeCompare(b.fullName)),
		[repoRows],
	);

	return { data, repositories, isReady, counts };
}
