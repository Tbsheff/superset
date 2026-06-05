import { describe, expect, test } from "bun:test";
import { buildShallowCloneCommand, CLONE_TOKEN_ENV } from "./cloneCommand.ts";

const SECRET = "ghs_super_secret_token";

describe("buildShallowCloneCommand", () => {
	test("is always a shallow, single-branch, no-tags clone", () => {
		const cmd = buildShallowCloneCommand({
			url: "https://github.com/o/r.git",
			workdir: "workspace",
			baseRef: "main",
			authenticated: true,
		});
		expect(cmd).toContain("--depth=1");
		expect(cmd).toContain("--single-branch");
		expect(cmd).toContain("--no-tags");
		expect(cmd).toContain("--branch 'main'");
		expect(cmd).toContain("'https://github.com/o/r.git'");
		expect(cmd).toContain(" workspace".trim());
	});

	test("authenticated clone references the token ENV VAR, never an inline secret", () => {
		// The builder never even receives the token, so the only way the secret can
		// reach the sandbox is the env argument the caller passes separately.
		const cmd = buildShallowCloneCommand({
			url: "https://github.com/o/r.git",
			workdir: "workspace",
			baseRef: "main",
			authenticated: true,
		});
		expect(cmd).toContain(`$${CLONE_TOKEN_ENV}`);
		expect(cmd).toContain("credential.helper");
		expect(cmd).toContain("username=x-access-token");
		expect(cmd).not.toContain(SECRET);
	});

	test("anonymous clone attaches no credential helper", () => {
		const cmd = buildShallowCloneCommand({
			url: "https://github.com/o/r.git",
			workdir: "workspace",
			baseRef: "main",
			authenticated: false,
		});
		expect(cmd).not.toContain("credential.helper");
		expect(cmd).not.toContain(CLONE_TOKEN_ENV);
		expect(cmd.startsWith("git clone")).toBe(true);
	});

	test("omits --branch when no base ref is given (clones default branch)", () => {
		const cmd = buildShallowCloneCommand({
			url: "https://github.com/o/r.git",
			workdir: "workspace",
			authenticated: false,
		});
		expect(cmd).not.toContain("--branch");
	});

	test("single-quotes the url and base ref against shell injection", () => {
		const cmd = buildShallowCloneCommand({
			url: "https://github.com/o/r.git; rm -rf /",
			workdir: "workspace",
			baseRef: "main'; touch pwned; '",
			authenticated: false,
		});
		// The metacharacters land inside single quotes, so the outer shell treats
		// them as literal path/ref text rather than command separators.
		expect(cmd).toContain("'https://github.com/o/r.git; rm -rf /'");
		expect(cmd).toContain("'main'\\''; touch pwned; '\\'''");
	});
});
