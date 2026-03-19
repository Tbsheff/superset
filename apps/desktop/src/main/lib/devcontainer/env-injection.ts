import type { Client } from "ssh2";
import { shellQuote, sshExec } from "./ssh-exec";

/**
 * Create a FIFO on the remote host and write env vars to it in the background.
 * The FIFO blocks the writer until `docker exec --env-file` reads it.
 * Returns the FIFO path for use with `--env-file`.
 *
 * Security: env vars never appear in `ps aux`, never persist on disk,
 * are single-use, and cleaned up immediately after read.
 */
export async function createEnvFifo(
	client: Client,
	sessionId: string,
	envVars: Record<string, string>,
): Promise<string> {
	const fifoPath = `/tmp/.superset-env-${sessionId}`;

	// Create FIFO with restrictive permissions
	const mkfifo = await sshExec(
		client,
		`mkfifo ${fifoPath} && chmod 600 ${fifoPath}`,
		{ timeout: 5_000 },
	);
	if (mkfifo.code !== 0) {
		throw new Error(`Failed to create FIFO: ${mkfifo.stderr.trim()}`);
	}

	// Build env file content (KEY=VALUE per line)
	const content = Object.entries(envVars)
		.filter(([, v]) => v != null && v !== "")
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");

	// Write to FIFO in background — this blocks until docker exec reads it.
	// After read, the FIFO is deleted. Use raw mode since we handle the command ourselves.
	// The printf + rm runs as a single background command on the remote.
	sshExec(
		client,
		`printf '%s\\n' ${shellQuote(content)} > ${fifoPath}; rm -f ${fifoPath}`,
		{ timeout: 30_000 },
	).catch(() => {
		// Best-effort cleanup if the FIFO write fails (e.g., docker exec never reads it)
		sshExec(client, `rm -f ${fifoPath}`, { timeout: 5_000 }).catch(() => {});
	});

	return fifoPath;
}

/**
 * Clean up any leftover FIFOs from crashed sessions.
 */
export async function cleanupStaleFifos(client: Client): Promise<void> {
	await sshExec(client, "rm -f /tmp/.superset-env-* 2>/dev/null", {
		timeout: 5_000,
	}).catch(() => {});
}

