import { describe, expect, it } from "bun:test";
import { extractRequestedReviewers } from "./extractRequestedReviewers";

describe("extractRequestedReviewers", () => {
	it("returns user logins", () => {
		expect(
			extractRequestedReviewers([{ login: "alice" }, { login: "bob" }]),
		).toEqual(["alice", "bob"]);
	});

	it("skips teams (no login) and keeps users", () => {
		expect(
			extractRequestedReviewers([
				{ login: "alice" },
				{ slug: "platform-team", name: "Platform" },
				{ login: "carol" },
			]),
		).toEqual(["alice", "carol"]);
	});

	it("returns [] for null, undefined, or non-arrays", () => {
		expect(extractRequestedReviewers(null)).toEqual([]);
		expect(extractRequestedReviewers(undefined)).toEqual([]);
		expect(extractRequestedReviewers("nope")).toEqual([]);
		expect(extractRequestedReviewers({ login: "x" })).toEqual([]);
	});

	it("ignores malformed entries", () => {
		expect(
			extractRequestedReviewers([null, { login: 42 }, { login: "ok" }]),
		).toEqual(["ok"]);
	});
});
