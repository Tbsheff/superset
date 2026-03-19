/**
 * Devcontainer Terminal Runtime
 *
 * Implements TerminalRuntime for devcontainer-backed terminal sessions.
 * Sessions run inside a Docker container via `docker exec -it` over SSH.
 *
 * Two session types:
 * - Agent session: writes a script file inside the container, executes it via
 *   `docker exec -it --env-file <fifo> bash -l /tmp/script.sh`
 * - Manual terminal: interactive login shell via
 *   `docker exec -it --env-file <fifo> /bin/bash -l`
 *
 * The outer SSH command is wrapped in `bash -l -c '...'` by sshExecPty so that
 * Docker is guaranteed to be in PATH on the remote host.
 */

import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { ClientChannel } from "ssh2";
import type { CreateSessionParams, SessionResult } from "../terminal/types";
import type {
	TerminalCapabilities,
	TerminalManagement,
	TerminalRuntime,
} from "../workspace-runtime/types";
import { createEnvFifo } from "./env-injection";
import { sshExec, sshExecPty } from "./ssh-exec";
import type { Client } from "./types";

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type DevcontainerSessionType = "agent" | "terminal";

export interface DevcontainerSessionConfig {
	/** Docker container ID */
	containerId: string;
	/** Working directory inside the container */
	workDir: string;
	/** Remote user to run as inside the container */
	remoteUser: string;
	/** Environment variables to inject via FIFO */
	envVars?: Record<string, string>;
	/** Agent command string (only for agent sessions) */
	agentCommand?: string;
	/** Session type - defaults to "terminal" */
	sessionType?: DevcontainerSessionType;
}

interface DevcontainerSession {
	/** Unique session ID (nanoid) */
	sessionId: string;
	/** paneId from CreateSessionParams */
	paneId: string;
	workspaceId: string;
	channel: ClientChannel;
	cols: number;
	rows: number;
	isAlive: boolean;
	cwd: string;
	lastActive: number;
	sessionType: DevcontainerSessionType;
	/** Path to the script file inside the container (agent sessions only) */
	scriptPath: string | null;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class DevcontainerTerminalRuntime
	extends EventEmitter
	implements TerminalRuntime
{
	private sessions = new Map<string, DevcontainerSession>();
	client: Client;
	private sessionConfig: DevcontainerSessionConfig;

	readonly capabilities: TerminalCapabilities = {
		persistent: false,
		coldRestore: false,
	};

	readonly management: TerminalManagement = {
		listSessions: async () => ({
			sessions: Array.from(this.sessions.values()).map((s) => ({
				sessionId: s.paneId,
				workspaceId: s.workspaceId,
				paneId: s.paneId,
				isAlive: s.isAlive,
				attachedClients: 1,
				pid: null,
				shell: "docker-exec",
			})),
		}),
		killAllSessions: async () => {
			for (const [paneId] of this.sessions) {
				await this.kill({ paneId });
			}
		},
		resetHistoryPersistence: async () => {
			// No-op for devcontainer sessions
		},
	};

	constructor(client: Client, sessionConfig: DevcontainerSessionConfig) {
		super();
		this.client = client;
		this.sessionConfig = sessionConfig;
	}

	createOrAttach: TerminalRuntime["createOrAttach"] = async (
		params: CreateSessionParams,
	): Promise<SessionResult> => {
		const { paneId, workspaceId, cols = 80, rows = 24 } = params;

		console.log(
			"[devcontainer-terminal] createOrAttach called, paneId:",
			paneId,
			"containerId:",
			this.sessionConfig.containerId,
		);

		try {
			// Reuse existing alive session
			const existing = this.sessions.get(paneId);
			if (existing?.isAlive) {
				console.log(
					"[devcontainer-terminal] Reusing existing session for paneId:",
					paneId,
				);
				return {
					isNew: false,
					scrollback: "",
					wasRecovered: false,
				};
			}

			const {
				containerId,
				workDir,
				remoteUser,
				envVars = {},
				agentCommand,
				sessionType = "terminal",
			} = this.sessionConfig;

			const sessionId = nanoid();
			const cwd = params.cwd ?? workDir;

			// Create FIFO for env var injection
			console.log(
				"[devcontainer-terminal] Creating env FIFO for sessionId:",
				sessionId,
			);
			const fifoPath = await createEnvFifo(this.client, sessionId, envVars);
			console.log("[devcontainer-terminal] FIFO created at:", fifoPath);

			let scriptPath: string | null = null;
			let dockerExecCmd: string;

			if (sessionType === "agent" && agentCommand) {
				// Write agent script inside the container via stdin pipe
				scriptPath = `/tmp/superset-agent-${sessionId}.sh`;
				const scriptContent = `#!/bin/bash\n${agentCommand}\n`;

				// Write script content into the container by piping stdin through docker exec.
				// bash -l on the outer SSH command ensures docker is in PATH.
				await new Promise<void>((resolve, reject) => {
					this.client.exec(
						`bash -l -c 'docker exec -i ${containerId} bash -c '"'"'cat > ${scriptPath} && chmod +x ${scriptPath}'"'"''`,
						(err, stream) => {
							if (err) {
								reject(err);
								return;
							}
							stream.on("close", (code: number) => {
								if (code === 0) resolve();
								else
									reject(
										new Error(
											`Failed to write agent script into container: exit code ${code}`,
										),
									);
							});
							stream.end(scriptContent);
						},
					);
				});

				dockerExecCmd = `docker exec -it --env-file ${fifoPath} -u ${remoteUser} -w ${cwd} ${containerId} bash -l ${scriptPath}`;
			} else {
				// Interactive login shell
				dockerExecCmd = `docker exec -it --env-file ${fifoPath} -u ${remoteUser} -w ${cwd} ${containerId} /bin/bash -l`;
			}

			console.log(
				"[devcontainer-terminal] Opening channel for",
				paneId,
				"type:",
				sessionType,
				"cmd:",
				dockerExecCmd,
			);

			const channel = await sshExecPty(this.client, dockerExecCmd, {
				cols,
				rows,
			});
			console.log(
				"[devcontainer-terminal] sshExecPty resolved for paneId:",
				paneId,
			);

			const session: DevcontainerSession = {
				sessionId,
				paneId,
				workspaceId,
				channel,
				cols,
				rows,
				isAlive: true,
				cwd,
				lastActive: Date.now(),
				sessionType,
				scriptPath,
			};

			this.sessions.set(paneId, session);

			channel.on("data", (data: Buffer) => {
				session.lastActive = Date.now();
				this.emit(`data:${paneId}`, data.toString());
			});

			channel.stderr.on("data", (data: Buffer) => {
				session.lastActive = Date.now();
				this.emit(`data:${paneId}`, data.toString());
			});

			channel.on("close", () => {
				session.isAlive = false;
				this._cleanupScriptFile(session);
				this.emit(`exit:${paneId}`, 0, undefined, "exited");
			});

			channel.on("error", (channelErr: Error) => {
				this.emit(`error:${paneId}`, {
					error: channelErr.message,
					code: "DOCKER_EXEC_CHANNEL_ERROR",
				});
			});

			console.log(
				"[devcontainer-terminal] Channel open for",
				paneId,
				"sessionId:",
				sessionId,
			);

			return {
				isNew: true,
				scrollback: "",
				wasRecovered: false,
			};
		} catch (error) {
			console.log("[devcontainer-terminal] Error in createOrAttach:", error);
			throw error;
		}
	};

	write: TerminalRuntime["write"] = (params) => {
		const session = this.sessions.get(params.paneId);
		if (!session?.isAlive) {
			throw new Error(`Session ${params.paneId} not found or not alive`);
		}
		session.channel.write(params.data);
		session.lastActive = Date.now();
	};

	resize: TerminalRuntime["resize"] = (params) => {
		const session = this.sessions.get(params.paneId);
		if (!session?.isAlive) return;
		session.cols = params.cols;
		session.rows = params.rows;
		session.channel.setWindow(
			params.rows,
			params.cols,
			params.rows * 16,
			params.cols * 8,
		);
	};

	signal: TerminalRuntime["signal"] = (params) => {
		const session = this.sessions.get(params.paneId);
		if (!session?.isAlive) return;
		// SSH channels don't support arbitrary signals directly;
		// send Ctrl+C for SIGINT
		if (!params.signal || params.signal === "SIGINT") {
			session.channel.write("\x03");
		}
	};

	kill: TerminalRuntime["kill"] = async (params) => {
		const session = this.sessions.get(params.paneId);
		if (!session) return;
		session.isAlive = false;
		this._cleanupScriptFile(session);
		session.channel.close();
		this.sessions.delete(params.paneId);
	};

	detach: TerminalRuntime["detach"] = (params) => {
		// Remove data listeners but keep channel alive
		this.removeAllListeners(`data:${params.paneId}`);
	};

	clearScrollback: TerminalRuntime["clearScrollback"] = (params) => {
		const session = this.sessions.get(params.paneId);
		if (!session?.isAlive) return;
		session.channel.write("\x1b[2J\x1b[3J\x1b[H");
	};

	ackColdRestore: TerminalRuntime["ackColdRestore"] = () => {
		// No-op (no cold restore support)
	};

	getSession: TerminalRuntime["getSession"] = (paneId) => {
		const session = this.sessions.get(paneId);
		if (!session) return null;
		return {
			isAlive: session.isAlive,
			cwd: session.cwd,
			lastActive: session.lastActive,
		};
	};

	killByWorkspaceId: TerminalRuntime["killByWorkspaceId"] = async (
		workspaceId,
	) => {
		let killed = 0;
		let failed = 0;
		for (const [paneId, session] of this.sessions) {
			if (session.workspaceId === workspaceId) {
				try {
					await this.kill({ paneId });
					killed++;
				} catch {
					failed++;
				}
			}
		}
		return { killed, failed };
	};

	getSessionCountByWorkspaceId: TerminalRuntime["getSessionCountByWorkspaceId"] =
		async (workspaceId) => {
			let count = 0;
			for (const session of this.sessions.values()) {
				if (session.workspaceId === workspaceId && session.isAlive) {
					count++;
				}
			}
			return count;
		};

	refreshPromptsForWorkspace: TerminalRuntime["refreshPromptsForWorkspace"] = (
		workspaceId,
	) => {
		for (const session of this.sessions.values()) {
			if (session.workspaceId === workspaceId && session.isAlive) {
				session.channel.write("\n");
			}
		}
	};

	/**
	 * Update the SSH client after a reconnection.
	 * Called by the registry when it detects the cached runtime has a stale client.
	 */
	updateClient(client: Client): void {
		this.client = client;
	}

	detachAllListeners(): void {
		for (const event of this.eventNames()) {
			const name = String(event);
			if (
				name.startsWith("data:") ||
				name.startsWith("exit:") ||
				name.startsWith("error:") ||
				name.startsWith("disconnect:")
			) {
				this.removeAllListeners(event);
			}
		}
	}

	cleanup: TerminalRuntime["cleanup"] = async () => {
		for (const [paneId] of this.sessions) {
			await this.kill({ paneId });
		}
		this.detachAllListeners();
	};

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Remove the agent script file from inside the container.
	 * Fire-and-forget — failures are silently swallowed.
	 */
	private _cleanupScriptFile(session: DevcontainerSession): void {
		if (!session.scriptPath) return;
		const { containerId } = this.sessionConfig;
		const scriptPath = session.scriptPath;
		session.scriptPath = null;
		sshExec(this.client, `docker exec ${containerId} rm -f ${scriptPath}`, {
			timeout: 5_000,
		}).catch(() => {});
	}
}
