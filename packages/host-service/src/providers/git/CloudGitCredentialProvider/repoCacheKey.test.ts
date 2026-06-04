import { describe, expect, test } from "bun:test";
import { repoCacheKey } from "./repoCacheKey";

describe("repoCacheKey", () => {
	test("normalizes https, scp, and ssh forms to host/owner/name", () => {
		const key = "github.com/acme/alpha";
		expect(repoCacheKey("https://github.com/acme/alpha.git")).toBe(key);
		expect(repoCacheKey("git@github.com:acme/alpha.git")).toBe(key);
		expect(repoCacheKey("ssh://git@github.com/acme/alpha.git")).toBe(key);
		expect(repoCacheKey("https://github.com/acme/alpha/")).toBe(key);
		expect(repoCacheKey("HTTPS://GitHub.com/ACME/Alpha.git")).toBe(key);
	});

	test("drops embedded userinfo from a well-formed https remote", () => {
		const key = repoCacheKey(
			"https://ghs_secrettoken@github.com/acme/alpha.git",
		);
		expect(key).toBe("github.com/acme/alpha");
		expect(key).not.toContain("ghs_secrettoken");
	});

	test("strips leading userinfo from a malformed remote that fails URL parsing", () => {
		// No scheme and no scp colon, so both the scp regex and new URL() fail.
		const key = repoCacheKey("ghs_secrettoken@host.example/owner/repo.git");
		expect(key).toBe("host.example/owner/repo");
		expect(key).not.toContain("ghs_secrettoken");
	});

	test("rejects an unparseable remote that still has an embedded '@' token", () => {
		expect(() =>
			repoCacheKey("ghs_token@evil@host.example/owner/repo"),
		).toThrow();
	});
});
