import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import {
	type SyncAgentAuthSandbox,
	syncAgentAuthToSandbox,
} from "./syncAgentAuth.ts";

const CODEX_AUTH = JSON.stringify({
	auth_mode: "api_key",
	OPENAI_API_KEY: "sk-secret-value",
});
const CLAUDE_CREDS = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });

function makeFakeSandbox() {
	const commands: string[] = [];
	const sandbox: SyncAgentAuthSandbox = {
		process: {
			executeCommand: async (command: string) => {
				commands.push(command);
				return { exitCode: 0 };
			},
		},
	};
	return { sandbox, commands };
}

/** Decode the base64 payload the write command embeds for a given target path. */
function writtenContent(commands: string[], targetPath: string): string | null {
	const cmd = commands.find((c) => c.includes(`> '${targetPath}'`));
	if (!cmd) return null;
	const match = cmd.match(/printf '%s' '([A-Za-z0-9+/=]*)'/);
	return match?.[1] ? Buffer.from(match[1], "base64").toString() : null;
}

describe("syncAgentAuthToSandbox", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(os.tmpdir(), "sync-auth-"));
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	test("writes codex + claude creds and reports only filenames", async () => {
		await mkdir(join(home, ".codex"), { recursive: true });
		await writeFile(join(home, ".codex", "auth.json"), CODEX_AUTH);
		await writeFile(join(home, ".codex", "config.json"), "{}");
		const { sandbox, commands } = makeFakeSandbox();

		const result = await syncAgentAuthToSandbox(sandbox, {
			homeDir: home,
			readClaudeKeychain: async () => CLAUDE_CREDS,
		});

		expect(result.synced).toContain(".codex/auth.json");
		expect(result.synced).toContain(".codex/config.json");
		expect(result.synced).toContain(".claude/.credentials.json");
		// No secret value ever appears in the returned object.
		expect(JSON.stringify(result)).not.toContain("sk-secret-value");
		expect(JSON.stringify(result)).not.toContain("tok");
		// The actual bytes were written (base64-decoded from the exec command).
		expect(writtenContent(commands, ".codex/auth.json")).toBe(CODEX_AUTH);
		expect(writtenContent(commands, ".claude/.credentials.json")).toBe(
			CLAUDE_CREDS,
		);
		// Secrets ride only inside the base64 payload, never in plaintext.
		expect(commands.join("\n")).not.toContain("sk-secret-value");
	});

	test("skips codex when auth.json is absent, still syncs claude", async () => {
		const { sandbox } = makeFakeSandbox();
		const result = await syncAgentAuthToSandbox(sandbox, {
			homeDir: home,
			readClaudeKeychain: async () => CLAUDE_CREDS,
		});
		expect(result.skipped).toContain(".codex/auth.json");
		expect(result.synced).toContain(".claude/.credentials.json");
	});

	test("skips claude gracefully when the keychain read throws", async () => {
		await mkdir(join(home, ".codex"), { recursive: true });
		await writeFile(join(home, ".codex", "auth.json"), CODEX_AUTH);
		const { sandbox } = makeFakeSandbox();
		const result = await syncAgentAuthToSandbox(sandbox, {
			homeDir: home,
			readClaudeKeychain: async () => {
				throw new Error("no keychain item");
			},
		});
		expect(result.synced).toContain(".codex/auth.json");
		expect(result.skipped).toContain(".claude/.credentials.json");
	});

	test("one agent failing never throws (best-effort)", async () => {
		await mkdir(join(home, ".codex"), { recursive: true });
		await writeFile(join(home, ".codex", "auth.json"), CODEX_AUTH);
		const sandbox: SyncAgentAuthSandbox = {
			process: {
				executeCommand: async () => ({ exitCode: 1, result: "fs down" }),
			},
		};
		const result = await syncAgentAuthToSandbox(sandbox, {
			homeDir: home,
			readClaudeKeychain: async () => {
				throw new Error("no keychain");
			},
		});
		expect(result.synced).toHaveLength(0);
		expect(result.skipped).toContain(".codex/auth.json");
		expect(result.skipped).toContain(".claude/.credentials.json");
	});
});
