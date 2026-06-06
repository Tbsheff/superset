import { describe, expect, it } from "bun:test";
import { isMine, isNeedsMyReview, type TriagePr } from "./triage";

const pr = (over: Partial<TriagePr>): TriagePr => ({
	state: over.state ?? "open",
	isDraft: over.isDraft ?? false,
	reviewDecision: over.reviewDecision ?? null,
	authorLogin: over.authorLogin ?? "octocat",
	requestedReviewers: over.requestedReviewers ?? [],
});

describe("isNeedsMyReview", () => {
	it("matches precisely when I'm an explicit requested reviewer (case-insensitive)", () => {
		expect(
			isNeedsMyReview(pr({ requestedReviewers: ["Me", "other"] }), "me"),
		).toBe(true);
	});

	it("excludes me when reviewers are listed but I'm not one", () => {
		expect(isNeedsMyReview(pr({ requestedReviewers: ["someone"] }), "me")).toBe(
			false,
		);
	});

	it("approximates to 'any open PR I didn't author' when no reviewers are listed", () => {
		expect(isNeedsMyReview(pr({ authorLogin: "other" }), "me")).toBe(true);
		expect(isNeedsMyReview(pr({ authorLogin: "Me" }), "me")).toBe(false);
	});

	it("is false for draft, approved, closed, or unknown viewer", () => {
		expect(
			isNeedsMyReview(pr({ isDraft: true, authorLogin: "other" }), "me"),
		).toBe(false);
		expect(
			isNeedsMyReview(
				pr({ reviewDecision: "APPROVED", authorLogin: "other" }),
				"me",
			),
		).toBe(false);
		expect(
			isNeedsMyReview(pr({ state: "closed", authorLogin: "other" }), "me"),
		).toBe(false);
		expect(isNeedsMyReview(pr({ authorLogin: "other" }), null)).toBe(false);
	});
});

describe("isMine", () => {
	it("matches my authored PRs case-insensitively", () => {
		expect(isMine(pr({ authorLogin: "Me" }), "me")).toBe(true);
		expect(isMine(pr({ authorLogin: "other" }), "me")).toBe(false);
		expect(isMine(pr({ authorLogin: "me" }), null)).toBe(false);
	});
});
