import { describe, expect, test } from "bun:test";
import { isRuntimeProviderError } from "../../seam/index.ts";
import { parseRepoCoordinates } from "./parse-repo.ts";

describe("parseRepoCoordinates", () => {
	test("extracts owner/repo from an https github url", () => {
		expect(
			parseRepoCoordinates("https://github.com/superset/demo.git"),
		).toEqual({ owner: "superset", repo: "demo" });
		expect(parseRepoCoordinates("https://github.com/acme/widgets")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
	});

	test("throws (rather than minting a broad token) when owner/repo is missing", () => {
		let thrown: unknown;
		try {
			parseRepoCoordinates("https://example.test/just-one-segment");
		} catch (error) {
			thrown = error;
		}
		expect(isRuntimeProviderError(thrown)).toBe(true);
	});

	test("throws on an unparseable url", () => {
		expect(() => parseRepoCoordinates("not a url")).toThrow();
	});
});
