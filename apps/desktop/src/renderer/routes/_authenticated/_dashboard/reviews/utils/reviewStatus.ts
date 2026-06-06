import type { SelectGithubPullRequest } from "@superset/db/schema";
import type { PRState } from "renderer/screens/main/components/PRIcon";

/**
 * A PR's position in the review workflow, derived from its synced GitHub state.
 * This is the column model for the read-only triage board (slice 1); the
 * team-curated kanban (slice 3) persists its own columns instead.
 */
export type ReviewBucket =
	| "draft"
	| "needs_review"
	| "changes_requested"
	| "approved"
	| "merged";

export const REVIEW_BUCKET_ORDER: ReviewBucket[] = [
	"draft",
	"needs_review",
	"changes_requested",
	"approved",
	"merged",
];

export const REVIEW_BUCKET_LABEL: Record<ReviewBucket, string> = {
	draft: "Draft",
	needs_review: "Needs Review",
	changes_requested: "Changes Requested",
	approved: "Approved",
	merged: "Merged",
};

// GitHub's REST/webhook `state` is only "open" | "closed" — a merge surfaces as
// state="closed" with a non-null `mergedAt`, so merged-ness must key off
// `mergedAt`, never `state`.
type BucketInput = Pick<
	SelectGithubPullRequest,
	"state" | "isDraft" | "reviewDecision" | "mergedAt"
>;

export function isMergedPr(
	pr: Pick<SelectGithubPullRequest, "mergedAt">,
): boolean {
	return pr.mergedAt != null;
}

export function deriveReviewBucket(pr: BucketInput): ReviewBucket {
	if (isMergedPr(pr)) return "merged";
	if (pr.isDraft) return "draft";
	if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
	if (pr.reviewDecision === "APPROVED") return "approved";
	return "needs_review";
}

export function prIconState(
	pr: Pick<SelectGithubPullRequest, "state" | "isDraft" | "mergedAt">,
): PRState {
	if (isMergedPr(pr)) return "merged";
	if (pr.state === "closed") return "closed";
	if (pr.isDraft) return "draft";
	return "open";
}

export type ChecksStatus = "none" | "pending" | "success" | "failure";

export function coerceChecksStatus(value: string): ChecksStatus {
	if (value === "pending" || value === "success" || value === "failure") {
		return value;
	}
	return "none";
}
