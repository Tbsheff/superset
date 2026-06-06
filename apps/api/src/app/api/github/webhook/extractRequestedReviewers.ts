/**
 * GitHub's `requested_reviewers` payload mixes users and teams; only users carry
 * a `login`, which is what we match against for "needs my review". Teams (which
 * expose `slug`/`name` instead) are skipped.
 */
export function extractRequestedReviewers(reviewers: unknown): string[] {
	if (!Array.isArray(reviewers)) return [];
	return reviewers
		.map((reviewer) =>
			reviewer &&
			typeof reviewer === "object" &&
			"login" in reviewer &&
			typeof reviewer.login === "string"
				? reviewer.login
				: undefined,
		)
		.filter((login): login is string => typeof login === "string");
}
