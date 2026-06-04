import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeSandboxFileViaExec } from "./writeSandboxFileViaExec.ts";

const execFileAsync = promisify(execFile);

/**
 * The slice of the Daytona sandbox the auth sync writes through. Files are
 * written via `process.executeCommand` + base64 (see `writeSandboxFileViaExec`)
 * rather than `fs.uploadFile`, which needs the `form-data` module the bundled
 * host-service runtime can't resolve. Paths resolve against the sandbox user
 * `$HOME`, the same convention `fs.uploadFile`/`runtimeFs()` use.
 */
interface SandboxProcess {
	executeCommand(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
		timeout?: number,
	): Promise<{ result?: string; exitCode?: number }>;
}

export interface SyncAgentAuthSandbox {
	process: SandboxProcess;
}

/** Write one home-relative file into the sandbox via executeCommand + base64. */
function writeToSandbox(
	sandbox: SyncAgentAuthSandbox,
	content: Buffer,
	homeRelativePath: string,
	mode?: string,
): Promise<void> {
	return writeSandboxFileViaExec(
		(command) => sandbox.process.executeCommand(command),
		content,
		homeRelativePath,
		mode ? { mode } : undefined,
	);
}

export interface SyncAgentAuthOptions {
	/** Host home directory; defaults to `os.homedir()`. Injectable for tests. */
	homeDir?: string;
	/**
	 * Reads the macOS keychain item the Claude Code CLI stores its credentials
	 * in. Defaults to `security find-generic-password`. Injectable for tests; a
	 * failure (no item / not macOS) makes the Claude sync skip, never throw.
	 */
	readClaudeKeychain?: () => Promise<string>;
}

/**
 * Result of an auth sync. By contract this carries ONLY filenames, never
 * credential values: `synced`/`skipped` list the destination sandbox paths that
 * were (or were not) written. Nothing here, and nothing logged by this module,
 * exposes a secret.
 */
export interface SyncAgentAuthResult {
	synced: string[];
	skipped: string[];
}

const CODEX_DIR = ".codex";
const CLAUDE_DIR = ".claude";

async function readHostFile(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

async function defaultReadClaudeKeychain(): Promise<string> {
	const { stdout } = await execFileAsync("security", [
		"find-generic-password",
		"-s",
		"Claude Code-credentials",
		"-w",
	]);
	return stdout.trimEnd();
}

/**
 * Uploads the HOST user's local agent credentials into the sandbox user home so
 * the in-sandbox Codex/Claude CLIs authenticate as the host user. Each agent is
 * isolated in its own try/catch so a missing credential for one never blocks the
 * other (or provisioning). Returns only destination filenames — read -> upload ->
 * drop; credential VALUES are never logged, persisted, or returned.
 */
export async function syncAgentAuthToSandbox(
	sandbox: SyncAgentAuthSandbox,
	opts?: SyncAgentAuthOptions,
): Promise<SyncAgentAuthResult> {
	const homeDir = opts?.homeDir ?? os.homedir();
	const synced: string[] = [];
	const skipped: string[] = [];

	await syncCodex(sandbox, homeDir, synced, skipped);
	await syncClaude(
		sandbox,
		opts?.readClaudeKeychain ?? defaultReadClaudeKeychain,
		synced,
		skipped,
	);

	return { synced, skipped };
}

async function syncCodex(
	sandbox: SyncAgentAuthSandbox,
	homeDir: string,
	synced: string[],
	skipped: string[],
): Promise<void> {
	try {
		const authBytes = await readHostFile(join(homeDir, CODEX_DIR, "auth.json"));
		if (!authBytes) {
			skipped.push(`${CODEX_DIR}/auth.json`);
			return;
		}
		await writeToSandbox(sandbox, authBytes, `${CODEX_DIR}/auth.json`, "600");
		synced.push(`${CODEX_DIR}/auth.json`);

		const configBytes = await readHostFile(
			join(homeDir, CODEX_DIR, "config.json"),
		);
		if (configBytes) {
			await writeToSandbox(sandbox, configBytes, `${CODEX_DIR}/config.json`);
			synced.push(`${CODEX_DIR}/config.json`);
		} else {
			skipped.push(`${CODEX_DIR}/config.json`);
		}
	} catch (error) {
		// Never surface the value; only that codex could not be synced.
		console.warn("[syncAgentAuth] codex sync failed:", describe(error));
		skipped.push(`${CODEX_DIR}/auth.json`);
	}
}

async function syncClaude(
	sandbox: SyncAgentAuthSandbox,
	readKeychain: () => Promise<string>,
	synced: string[],
	skipped: string[],
): Promise<void> {
	try {
		const credentials = await readKeychain();
		if (!credentials.trim()) {
			skipped.push(`${CLAUDE_DIR}/.credentials.json`);
			return;
		}
		await writeToSandbox(
			sandbox,
			Buffer.from(credentials, "utf8"),
			`${CLAUDE_DIR}/.credentials.json`,
			"600",
		);
		synced.push(`${CLAUDE_DIR}/.credentials.json`);
	} catch (error) {
		// No keychain item / not macOS / upload failed: skip gracefully.
		console.warn("[syncAgentAuth] claude sync skipped:", describe(error));
		skipped.push(`${CLAUDE_DIR}/.credentials.json`);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
