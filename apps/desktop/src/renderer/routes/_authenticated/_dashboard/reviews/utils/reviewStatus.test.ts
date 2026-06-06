import { describe, expect, it } from "bun:test";
import {
	coerceChecksStatus,
	deriveReviewBucket,
	isMergedPr,
	prIconState,
} from "./reviewStatus";

// Minimal shapes — these helpers only read the picked fields.
const bucketPr = (over: {
	state?: string;
	isDraft?: boolean;
	reviewDecision?: string | null;
	mergedAt?: Date | null;
}) => ({
	state: over.state ?? "open",
	isDraft: over.isDraft ?? false,
	reviewDecision: over.reviewDecision ?? null,
	mergedAt: over.mergedAt ?? null,
});

describe("isMergedPr", () => {
	it("is true only when mergedAt is set (never from state)", () => {
		expect(isMergedPr({ mergedAt: new Date() })).toBe(true);
		expect(isMergedPr({ mergedAt: null })).toBe(false);
	});
});

describe("deriveReviewBucket", () => {
	it("buckets a merged PR by mergedAt even though state is 'closed'", () => {
		// The critical case: GitHub stores merged PRs as state='closed'.
		expect(
			deriveReviewBucket(bucketPr({ state: "closed", mergedAt: new Date() })),
		).toBe("merged");
	});

	it("treats a closed-unmerged PR as needs_review (not merged)", () => {
		expect(deriveReviewBucket(bucketPr({ state: "closed" }))).toBe(
			"needs_review",
		);
	});

	it("prioritizes draft over review decision", () => {
		expect(
			deriveReviewBucket(
				bucketPr({ isDraft: true, reviewDecision: "APPROVED" }),
			),
		).toBe("draft");
	});

	it("maps review decisions", () => {
		expect(
			deriveReviewBucket(bucketPr({ reviewDecision: "CHANGES_REQUESTED" })),
		).toBe("changes_requested");
		expect(deriveReviewBucket(bucketPr({ reviewDecision: "APPROVED" }))).toBe(
			"approved",
		);
		expect(deriveReviewBucket(bucketPr({ reviewDecision: null }))).toBe(
			"needs_review",
		);
	});

	it("merged wins over draft", () => {
		expect(
			deriveReviewBucket(bucketPr({ isDraft: true, mergedAt: new Date() })),
		).toBe("merged");
	});
});

describe("prIconState", () => {
	it("returns merged for a merged PR regardless of state", () => {
		expect(
			prIconState({ state: "closed", isDraft: false, mergedAt: new Date() }),
		).toBe("merged");
	});
	it("returns closed for a closed-unmerged PR", () => {
		expect(
			prIconState({ state: "closed", isDraft: false, mergedAt: null }),
		).toBe("closed");
	});
	it("returns draft / open for open PRs", () => {
		expect(prIconState({ state: "open", isDraft: true, mergedAt: null })).toBe(
			"draft",
		);
		expect(prIconState({ state: "open", isDraft: false, mergedAt: null })).toBe(
			"open",
		);
	});
});

describe("coerceChecksStatus", () => {
	it("passes through known values and defaults unknown to none", () => {
		expect(coerceChecksStatus("success")).toBe("success");
		expect(coerceChecksStatus("pending")).toBe("pending");
		expect(coerceChecksStatus("failure")).toBe("failure");
		expect(coerceChecksStatus("none")).toBe("none");
		expect(coerceChecksStatus("garbage")).toBe("none");
	});
});
