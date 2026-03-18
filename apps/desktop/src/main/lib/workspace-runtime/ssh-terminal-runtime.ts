/**
 * SSH Terminal Runtime
 *
 * Implements TerminalRuntime for SSH-backed terminal sessions.
 * Each terminal pane gets an SSH channel (shell) via the connection manager.
 */

import { EventEmitter } from "node:events";
import type { ClientChannel } from "ssh2";
import type { CreateSessionParams, SessionResult } from "../terminal/types";
import {
	getSshConnectionManager,
	type SshHostConfig,
} from "./ssh-connection-manager";
import type {
	TerminalCapabilities,
	TerminalManagement,
	TerminalRuntime,
} from "./types";

interface SshSession {
	channel: ClientChannel;
	paneId: string;
	workspaceId: string;
	cols: number;
	rows: number;
	isAlive: boolean;
	cwd: string;
	lastActive: number;
}

export class SshTerminalRuntime
	extends EventEmitter
	implements TerminalRuntime
{
	private sessions = new Map<string, SshSession>();
	private hostConfig: SshHostConfig;

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
				shell: "ssh",
			})),
		}),
		killAllSessions: async () => {
			for (const [paneId] of this.sessions) {
				await this.kill({ paneId });
			}
		},
		resetHistoryPersistence: async () => {
			// No-op for SSH
		},
	};

	constructor(hostConfig: SshHostConfig) {
		super();
		this.hostConfig = hostConfig;
	}

	createOrAttach: TerminalRuntime["createOrAttach"] = async (
		params: CreateSessionParams,
	): Promise<SessionResult> => {
		console.log("[ssh-terminal] createOrAttach:", params.paneId);
		const { paneId, workspaceId, cols = 80, rows = 24 } = params;

		// Reuse existing alive session
		const existing = this.sessions.get(paneId);
		if (existing?.isAlive) {
			return {
				isNew: false,
				scrollback: "",
				wasRecovered: false,
			};
		}

		const manager = getSshConnectionManager();
		console.log("[ssh-terminal] Connecting to SSH...");
		const client = await manager.connect(this.hostConfig);
		console.log("[ssh-terminal] SSH connected, opening shell...");

		return new Promise<SessionResult>((resolve, reject) => {
			client.shell(
				{
					term: "xterm-256color",
					cols,
					rows,
				},
				(err, channel) => {
					if (err) {
						console.log("[ssh-terminal] Error:", err);
						reject(err);
						return;
					}
					console.log("[ssh-terminal] Shell opened for", paneId);

					const cwd = params.cwd ?? this.hostConfig.defaultCwd ?? "~";

					const session: SshSession = {
						channel,
						paneId,
						workspaceId,
						cols,
						rows,
						isAlive: true,
						cwd,
						lastActive: Date.now(),
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
						this.emit(`exit:${paneId}`, 0, undefined, "exited");
					});

					channel.on("error", (channelErr: Error) => {
						this.emit(`error:${paneId}`, {
							error: channelErr.message,
							code: "SSH_CHANNEL_ERROR",
						});
					});

					// cd to target directory if specified
					if (cwd && cwd !== "~") {
						channel.write(`cd ${cwd}\n`);
					}

					resolve({
						isNew: true,
						scrollback: "",
						wasRecovered: false,
					});
				},
			);
		});
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
		// SSH channels don't support arbitrary signals directly,
		// send Ctrl+C for SIGINT
		if (!params.signal || params.signal === "SIGINT") {
			session.channel.write("\x03");
		}
	};

	kill: TerminalRuntime["kill"] = async (params) => {
		const session = this.sessions.get(params.paneId);
		if (!session) return;
		session.isAlive = false;
		session.channel.close();
		this.sessions.delete(params.paneId);
	};

	detach: TerminalRuntime["detach"] = (params) => {
		// For SSH, detach just removes data listeners but keeps channel alive
		const session = this.sessions.get(params.paneId);
		if (!session) return;
		this.removeAllListeners(`data:${params.paneId}`);
	};

	clearScrollback: TerminalRuntime["clearScrollback"] = (params) => {
		const session = this.sessions.get(params.paneId);
		if (!session?.isAlive) return;
		// Send ANSI clear sequence
		session.channel.write("\x1b[2J\x1b[3J\x1b[H");
	};

	ackColdRestore: TerminalRuntime["ackColdRestore"] = () => {
		// No-op for SSH (no cold restore support)
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

	detachAllListeners(): void {
		const events = this.eventNames();
		for (const event of events) {
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
}
