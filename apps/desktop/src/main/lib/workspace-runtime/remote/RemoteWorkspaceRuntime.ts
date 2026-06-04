/**
 * Remote Workspace Runtime
 *
 * Bridges a host-service-backed remote sandbox (Daytona) into the desktop
 * `WorkspaceRuntime` boundary so its terminal streams render in the renderer
 * exactly like a local daemon session.
 *
 * The desktop main bundle must NOT pull in `@daytonaio/sdk`, so this module does
 * not import the host-service `DaytonaPtyTransport` directly. Instead it depends
 * on the structural `RemotePtyTransport` seam below, which the host-service
 * `DaytonaPtyTransport` satisfies 1:1 (string `onData`, string `write`, byte
 * `signalInterrupt`, `(cols, rows)` `resize`, kill-not-disconnect). Production
 * wiring injects a factory that constructs the real transport over the
 * host-service connection; tests inject a fake that records calls.
 *
 * Invariants carried over from the daemon path (see local.ts / terminal.ts):
 * 1. The terminal surface is an EventEmitter that emits per-pane events:
 *    `data:${paneId}` for output, `exit:${paneId}` for a state transition.
 * 2. Exit is a state transition, NOT stream completion. The runtime emits
 *    `exit:${paneId}` and never calls `emit.complete()` on the subscriber's
 *    observable — paneIds are reused across restarts, so completing would
 *    strand listeners.
 * 3. kill() terminates the sandbox PTY; detach() leaves it running.
 */

import { EventEmitter } from "node:events";
import type { CreateSessionParams, SessionResult } from "../../terminal/types";
import type { ListSessionsResponse } from "../../terminal-host/types";
import type {
	TerminalCapabilities,
	TerminalManagement,
	TerminalRuntime,
	WorkspaceRuntime,
	WorkspaceRuntimeId,
} from "../types";

// =============================================================================
// Remote PTY Transport Seam
// =============================================================================

/**
 * The structural surface the desktop bridge drives on a remote PTY session.
 *
 * The host-service `DaytonaPtyTransport`
 * (`packages/host-service/src/runtime/adapters/daytona/DaytonaPtyTransport.ts`)
 * satisfies this shape exactly. Declaring it here — instead of importing the SDK
 * class — keeps the Daytona SDK out of the Electron main bundle and keeps the
 * desktop boundary provider-neutral.
 *
 * Strings on `onData`/`write` are deliberate: the transport owns the streaming
 * UTF-8 decode so the renderer never sees a glyph split across two byte chunks.
 */
export interface RemotePtyTransport {
	/** Subscribe to decoded terminal output. */
	onData(cb: (chunk: string) => void): { dispose(): void };
	/** Open the PTY and block until the byte stream is connected. */
	start(opts: {
		cols: number;
		rows: number;
		cwd?: string;
		envs?: Record<string, string>;
	}): Promise<void>;
	/** Write input verbatim; the caller owns the trailing newline. */
	write(data: string): Promise<void>;
	/** Send Ctrl+C as a raw byte so it is not line-buffered. */
	signalInterrupt(): Promise<void>;
	/** Resize the PTY, cols then rows. */
	resize(cols: number, rows: number): Promise<unknown>;
	/** Fires once when the remote process exits. */
	onExit(cb: (info: { exitCode: number; error?: string }) => void): void;
	/** kill() terminates the process; disconnect-only would leave it alive. */
	kill(): Promise<void>;
}

/**
 * Constructs a transport for one pane of one remote workspace. Production binds
 * this to the host-service sandbox for `workspaceId`; tests return a fake.
 */
export type RemotePtyTransportFactory = (args: {
	workspaceId: string;
	paneId: string;
}) => RemotePtyTransport;

// =============================================================================
// Per-pane session bookkeeping
// =============================================================================

interface RemoteSession {
	transport: RemotePtyTransport;
	dataSub: { dispose(): void };
	workspaceId: string;
	cwd: string;
	cols: number;
	rows: number;
	lastActive: number;
	isAlive: boolean;
}

const REMOTE_CAPABILITIES: TerminalCapabilities = {
	// Remote sandboxes do not persist across desktop restarts the way the local
	// daemon does, and there is no on-disk cold restore for them.
	persistent: false,
	coldRestore: false,
};

// =============================================================================
// Remote Terminal Runtime
// =============================================================================

/**
 * Adapts a set of remote PTY transports to the desktop `TerminalRuntime`
 * interface, emitting `data:${paneId}` / `exit:${paneId}` events on itself so
 * the existing terminal `stream` subscription wires up unchanged.
 */
class RemoteTerminalRuntime extends EventEmitter implements TerminalRuntime {
	readonly capabilities = REMOTE_CAPABILITIES;
	readonly management: TerminalManagement;

	private readonly sessions = new Map<string, RemoteSession>();

	constructor(private readonly transportFactory: RemotePtyTransportFactory) {
		super();
		this.management = {
			listSessions: () => Promise.resolve(this.listSessionsSync()),
			killAllSessions: async () => {
				await Promise.allSettled(
					[...this.sessions.keys()].map((paneId) => this.kill({ paneId })),
				);
			},
			// Remote sessions stream live; there is no host-side history writer to
			// reinitialize, so this is a no-op rather than an error.
			resetHistoryPersistence: () => Promise.resolve(),
		};
	}

	private listSessionsSync(): ListSessionsResponse {
		return {
			sessions: [...this.sessions.entries()].map(([paneId, session]) => ({
				sessionId: paneId,
				workspaceId: session.workspaceId,
				paneId,
				isAlive: session.isAlive,
				attachedClients: 0,
				pid: null,
			})),
		};
	}

	// ===========================================================================
	// Session Operations
	// ===========================================================================

	createOrAttach: TerminalRuntime["createOrAttach"] = async (
		params: CreateSessionParams,
	): Promise<SessionResult> => {
		const existing = this.sessions.get(params.paneId);
		if (existing?.isAlive) {
			existing.lastActive = Date.now();
			return { isNew: false, scrollback: "", wasRecovered: false };
		}

		const cols = params.cols ?? 80;
		const rows = params.rows ?? 24;
		const transport = this.transportFactory({
			workspaceId: params.workspaceId,
			paneId: params.paneId,
		});

		const dataSub = transport.onData((chunk) => {
			const session = this.sessions.get(params.paneId);
			if (session) session.lastActive = Date.now();
			this.emit(`data:${params.paneId}`, chunk);
		});

		transport.onExit(({ exitCode, error }) => {
			const session = this.sessions.get(params.paneId);
			if (session) {
				session.isAlive = false;
			}
			if (error) {
				this.emit(`error:${params.paneId}`, {
					error,
					code: "SUBPROCESS_ERROR",
				});
			}
			// Exit is a state transition, never stream completion. The subscriber
			// keeps its observable open so a same-paneId restart re-streams.
			this.emit(`exit:${params.paneId}`, exitCode, undefined, "exited");
			this.emit("terminalExit", {
				paneId: params.paneId,
				exitCode,
				reason: "exited",
			});
		});

		await transport.start({
			cols,
			rows,
			cwd: params.cwd,
		});

		this.sessions.set(params.paneId, {
			transport,
			dataSub,
			workspaceId: params.workspaceId,
			cwd: params.cwd ?? "",
			cols,
			rows,
			lastActive: Date.now(),
			isAlive: true,
		});

		return { isNew: true, scrollback: "", wasRecovered: false };
	};

	// Remote attach is idempotent; there is no in-flight supersede protocol to
	// cancel, so this is a no-op.
	cancelCreateOrAttach: TerminalRuntime["cancelCreateOrAttach"] = () => {};

	write: TerminalRuntime["write"] = ({ paneId, data }) => {
		const session = this.sessions.get(paneId);
		if (!session?.isAlive) {
			throw new Error(`Remote session ${paneId} not found or not alive`);
		}
		session.lastActive = Date.now();
		void session.transport.write(data);
	};

	resize: TerminalRuntime["resize"] = ({ paneId, cols, rows }) => {
		const session = this.sessions.get(paneId);
		if (!session?.isAlive) return;
		session.cols = cols;
		session.rows = rows;
		void session.transport.resize(cols, rows);
	};

	signal: TerminalRuntime["signal"] = ({ paneId }) => {
		const session = this.sessions.get(paneId);
		if (!session?.isAlive) return;
		void session.transport.signalInterrupt();
	};

	kill: TerminalRuntime["kill"] = async ({ paneId }) => {
		const session = this.sessions.get(paneId);
		if (!session) return;
		session.isAlive = false;
		session.dataSub.dispose();
		await session.transport.kill().catch(() => {});
		this.sessions.delete(paneId);
	};

	// Detach without killing: stop forwarding output but leave the remote PTY
	// running so a later createOrAttach can reconnect.
	detach: TerminalRuntime["detach"] = ({ paneId }) => {
		const session = this.sessions.get(paneId);
		if (!session) return;
		session.dataSub.dispose();
		this.sessions.delete(paneId);
	};

	clearScrollback: TerminalRuntime["clearScrollback"] = () => {
		// Remote scrollback lives in the sandbox PTY; the desktop holds none.
	};

	ackColdRestore: TerminalRuntime["ackColdRestore"] = () => {
		// No cold restore for remote sessions.
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

	// ===========================================================================
	// Workspace Operations
	// ===========================================================================

	killByWorkspaceId: TerminalRuntime["killByWorkspaceId"] = async (
		workspaceId,
	) => {
		const paneIds = [...this.sessions.entries()]
			.filter(([, session]) => session.workspaceId === workspaceId)
			.map(([paneId]) => paneId);
		let killed = 0;
		let failed = 0;
		for (const paneId of paneIds) {
			try {
				await this.kill({ paneId });
				killed++;
			} catch {
				failed++;
			}
		}
		return { killed, failed };
	};

	getSessionCountByWorkspaceId: TerminalRuntime["getSessionCountByWorkspaceId"] =
		(workspaceId) => {
			const count = [...this.sessions.values()].filter(
				(session) => session.isAlive && session.workspaceId === workspaceId,
			).length;
			return Promise.resolve(count);
		};

	refreshPromptsForWorkspace: TerminalRuntime["refreshPromptsForWorkspace"] = (
		workspaceId,
	) => {
		for (const session of this.sessions.values()) {
			if (session.isAlive && session.workspaceId === workspaceId) {
				void session.transport.write("\n");
			}
		}
	};

	// ===========================================================================
	// Event Source
	// ===========================================================================

	detachAllListeners(): void {
		this.removeAllListeners();
	}

	// ===========================================================================
	// Cleanup
	// ===========================================================================

	cleanup: TerminalRuntime["cleanup"] = async () => {
		await Promise.allSettled(
			[...this.sessions.keys()].map((paneId) => this.kill({ paneId })),
		);
		this.removeAllListeners();
	};
}

// =============================================================================
// Remote Workspace Runtime
// =============================================================================

/**
 * `WorkspaceRuntime` for workspaces whose host-service binding is
 * `runtimeKind === "remote"`. Selected by the registry; routes terminal ops to
 * the injected remote transport factory.
 */
export class RemoteWorkspaceRuntime implements WorkspaceRuntime {
	readonly id: WorkspaceRuntimeId = "remote";
	readonly terminal: TerminalRuntime;
	readonly capabilities: WorkspaceRuntime["capabilities"];

	constructor(transportFactory: RemotePtyTransportFactory) {
		this.terminal = new RemoteTerminalRuntime(transportFactory);
		this.capabilities = {
			terminal: this.terminal.capabilities,
		};
	}
}
