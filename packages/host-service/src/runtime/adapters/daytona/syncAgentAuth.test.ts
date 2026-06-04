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
	const folders: Array<{ path: string; mode: string }> = [];
	const uploads: Array<{ path: string; bytes: Buffer }> = [];
	const perms: Array<{ path: string; mode?: string }> = [];
	const sandbox: SyncAgentAuthSandbox = {
		fs: {
			createFolder: async (path, mode) => {
				folders.push({ path, mode });
			},
			uploadFile: async (file, remotePath) => {
				uploads.push({ path: remotePath, bytes: file });
			},
			setFilePermissions: async (path, p) => {
				perms.push({ path, mode: p.mode });
			},
		},
		process: { executeCommand: async () => ({}) },
	};
	return { sandbox, folders, uploads, perms };
}

describe("syncAgentAuthToSandbox", () => {
	let home: string;

	beforeEach(async () => {
		home = await mkdtemp(join(os.tmpdir(), "sync-auth-"));
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	test("uploads codex + claude creds and reports only filenames", async () => {
		await mkdir(join(home, ".codex"), { recursive: true });
		await writeFile(join(home, ".codex", "auth.json"), CODEX_AUTH);
		await writeFile(join(home, ".codex", "config.json"), "{}");
		const { sandbox, uploads } = makeFakeSandbox();

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
		// The actual bytes were uploaded.
		const authUpload = uploads.find((u) => u.path === ".codex/auth.json");
		expect(authUpload?.bytes.toString()).toBe(CODEX_AUTH);
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
			fs: {
				createFolder: async () => {
					throw new Error("fs down");
				},
				uploadFile: async () => {},
			},
			process: { executeCommand: async () => ({}) },
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
