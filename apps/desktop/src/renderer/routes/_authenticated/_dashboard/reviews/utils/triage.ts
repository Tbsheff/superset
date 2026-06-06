import type { SelectGithubPullRequest } from "@superset/db/schema";

export type TriagePr = Pick<
	SelectGithubPullRequest,
	"state" | "isDraft" | "reviewDecision" | "authorLogin" | "requestedReviewers"
>;

/**
 * A PR needs my review when it's open, not a draft, and not already approved.
 * When the synced row carries an explicit `requestedReviewers` list we match on
 * it precisely; before that data exists we approximate with "any open PR I
 * didn't author". `me` must be lowercased by the caller.
 */
export function isNeedsMyReview(pr: TriagePr, me: string | null): boolean {
	if (pr.state !== "open" || pr.isDraft) return false;
	if (pr.reviewDecision === "APPROVED") return false;
	if (me == null) return false;

	const reviewers = (pr.requestedReviewers ?? []).map((login) =>
		login.toLowerCase(),
	);
	if (reviewers.length > 0) return reviewers.includes(me);

	return pr.authorLogin.toLowerCase() !== me;
}

export function isMine(pr: TriagePr, me: string | null): boolean {
	return me != null && pr.authorLogin.toLowerCase() === me;
}
