import type { Client, ClientChannel } from "ssh2";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Shell-quote a string for use inside single quotes.
 * Handles strings containing single quotes by breaking out and escaping.
 */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Execute a command on a remote host via SSH.
 * All commands are wrapped in `bash -l -c '...'` to ensure login shell
 * environment (PATH includes Docker, nvm, brew, etc.).
 */
export function sshExec(
	client: Client,
	cmd: string,
	opts?: { timeout?: number; raw?: boolean },
): Promise<ExecResult> {
	const timeout = opts?.timeout ?? 120_000;
	const wrappedCmd = opts?.raw ? cmd : `bash -l -c ${shellQuote(cmd)}`;

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					`SSH command timed out after ${timeout}ms: ${cmd.slice(0, 100)}`,
				),
			);
		}, timeout);

		client.exec(wrappedCmd, (err, stream) => {
			if (err) {
				clearTimeout(timer);
				reject(err);
				return;
			}

			let stdout = "";
			let stderr = "";

			stream.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			stream.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			stream.on("close", (code: number) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	});
}

/**
 * Execute a command and return a live channel for PTY interaction.
 * Used for `docker exec -it` sessions where we need write/resize support.
 * The command IS wrapped in bash -l -c for PATH, but with PTY enabled.
 */
export function sshExecPty(
	client: Client,
	cmd: string,
	opts: { cols: number; rows: number },
): Promise<ClientChannel> {
	const wrappedCmd = `bash -l -c ${shellQuote(cmd)}`;

	return new Promise((resolve, reject) => {
		client.exec(
			wrappedCmd,
			{ pty: { term: "xterm-256color", cols: opts.cols, rows: opts.rows } },
			(err, stream) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(stream);
			},
		);
	});
}

/**
 * Write content to a file on the remote host via stdin pipe.
 * Avoids shell escaping issues entirely.
 */
export function sshWriteFile(
	client: Client,
	remotePath: string,
	content: string,
	opts?: { mode?: string },
): Promise<void> {
	const mode = opts?.mode ?? "644";
	return new Promise((resolve, reject) => {
		// Use cat to write stdin to file, then chmod
		client.exec(
			`bash -l -c 'cat > ${remotePath} && chmod ${mode} ${remotePath}'`,
			(err, stream) => {
				if (err) {
					reject(err);
					return;
				}
				stream.on("close", (code: number) => {
					if (code === 0) resolve();
					else
						reject(
							new Error(`Failed to write ${remotePath}: exit code ${code}`),
						);
				});
				stream.end(content);
			},
		);
	});
}
