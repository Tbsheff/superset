import type { HostDb } from "../../../db/index.ts";
import type { EventBus } from "../../../events/index.ts";
import {
	createTerminalSessionInternal,
	disposeSession,
} from "../../../terminal/terminal.ts";

export interface StartPtyShellOptions {
	terminalId: string;
	workspaceId: string;
	initialCommand?: string;
	cwd?: string;
	listed?: boolean;
	cols?: number;
	rows?: number;
}

/**
 * The shell handle a started PTY exposes. Every member forwards 1:1 to the
 * underlying `DaemonPty` the terminal session owns — no transformation.
 */
export interface PtyShellHandle {
	terminalId: string;
	pid: number;
	write(data: string): void;
	writeBytes(bytes: Uint8Array): void;
	resize(cols: number, rows: number): void;
	onData(cb: (chunk: string) => void): { dispose(): void };
	onExit(cb: (info: { exitCode: number; signal: number }) => void): {
		dispose(): void;
	};
	kill(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Thin pass-through to `createTerminalSessionInternal` (the same primitive v2
 * uses for interactive sessions, setup, and teardown). It re-implements no PTY
 * logic: `startShell` forwards its options unchanged and the returned handle
 * delegates `write`/`resize`/`kill`/`onData`/`onExit` straight to the session's
 * `pty`. This is the local adapter's execution surface.
 */
export class LocalPtyTransport {
	private readonly db: HostDb;
	private readonly eventBus?: EventBus;

	constructor(db: HostDb, eventBus?: EventBus) {
		this.db = db;
		this.eventBus = eventBus;
	}

	async startShell(
		opts: StartPtyShellOptions,
	): Promise<PtyShellHandle | { error: string }> {
		const session = await createTerminalSessionInternal({
			db: this.db,
			eventBus: this.eventBus,
			terminalId: opts.terminalId,
			workspaceId: opts.workspaceId,
			initialCommand: opts.initialCommand,
			cwd: opts.cwd,
			listed: opts.listed,
			cols: opts.cols,
			rows: opts.rows,
		});
		if ("error" in session) return session;

		const { pty } = session;
		return {
			terminalId: opts.terminalId,
			pid: pty.pid,
			write: (data) => pty.write(data),
			writeBytes: (bytes) => pty.writeBytes(bytes),
			resize: (cols, rows) => pty.resize(cols, rows),
			onData: (cb) => pty.onData(cb),
			onExit: (cb) => pty.onExit(cb),
			kill: (signal) => pty.kill(signal),
		};
	}

	dispose(terminalId: string): void {
		disposeSession(terminalId, this.db);
	}
}
