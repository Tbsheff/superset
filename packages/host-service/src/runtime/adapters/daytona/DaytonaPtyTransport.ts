import type { PtyHandle } from "@daytonaio/sdk";

/** The `Sandbox.process` slice the transport drives. */
export interface PtyProcess {
	createPty(
		options: {
			id: string;
			cols?: number;
			rows?: number;
			cwd?: string;
			envs?: Record<string, string>;
		} & { onData: (data: Uint8Array) => void | Promise<void> },
	): Promise<PtyHandle>;
	connectPty(
		sessionId: string,
		options: { onData: (data: Uint8Array) => void | Promise<void> },
	): Promise<PtyHandle>;
}

export interface PtySandbox {
	process: PtyProcess;
}

export interface DaytonaPtyStartOptions {
	cols: number;
	rows: number;
	cwd?: string;
	envs?: Record<string, string>;
}

/**
 * Owns a single Daytona PTY session and adapts its WebSocket byte stream to the
 * string-based desktop terminal seam.
 *
 * Daytona delivers terminal output as `Uint8Array` chunks over a WebSocket; a
 * multi-byte UTF-8 sequence can split across two chunks. ONE persistent
 * `TextDecoder({ stream: true })` per session stitches those boundaries so the
 * renderer never sees a corrupted glyph.
 *
 * Lifecycle facts encoded from the SDK: `id` is mandatory and is the
 * reconnect/kill handle; `waitForConnection()` must resolve before the first
 * `sendInput`; `disconnect()` leaves the process running — only `kill()`
 * terminates it.
 */
export class DaytonaPtyTransport {
	private handle: PtyHandle | null = null;
	private readonly decoder = new TextDecoder("utf-8");
	private readonly dataCbs = new Set<(chunk: string) => void>();

	constructor(
		private readonly sandbox: PtySandbox,
		private readonly paneId: string,
	) {}

	private emit(bytes: Uint8Array): void {
		const chunk = this.decoder.decode(bytes, { stream: true });
		if (chunk.length === 0) return;
		for (const cb of this.dataCbs) cb(chunk);
	}

	onData(cb: (chunk: string) => void): { dispose(): void } {
		this.dataCbs.add(cb);
		return {
			dispose: () => {
				this.dataCbs.delete(cb);
			},
		};
	}

	async start(opts: DaytonaPtyStartOptions): Promise<void> {
		this.handle = await this.sandbox.process.createPty({
			id: this.paneId,
			cols: opts.cols,
			rows: opts.rows,
			cwd: opts.cwd ?? "workspace",
			envs: opts.envs,
			onData: (bytes) => this.emit(bytes),
		});
		await this.handle.waitForConnection();
	}

	/** Reattach to a still-running PTY (e.g. after a transport reconnect). */
	async reconnect(): Promise<void> {
		this.handle = await this.sandbox.process.connectPty(this.paneId, {
			onData: (bytes) => this.emit(bytes),
		});
		await this.handle.waitForConnection();
	}

	private requireHandle(): PtyHandle {
		if (!this.handle) {
			throw new Error(
				`daytona-pty: session ${this.paneId} not started; call start() first`,
			);
		}
		return this.handle;
	}

	/** Caller controls the trailing newline, mirroring the local terminal seam. */
	write(data: string): Promise<void> {
		return this.requireHandle().sendInput(data);
	}

	/** Ctrl+C as a raw byte, not a string, so it is not line-buffered. */
	signalInterrupt(): Promise<void> {
		return this.requireHandle().sendInput(new Uint8Array([3]));
	}

	resize(cols: number, rows: number): Promise<unknown> {
		return this.requireHandle().resize(cols, rows);
	}

	onExit(cb: (info: { exitCode: number; error?: string }) => void): void {
		const handle = this.requireHandle();
		void handle.wait().then((result) => {
			cb({ exitCode: result.exitCode ?? 0, error: result.error });
		});
	}

	/** kill() terminates the process; disconnect() alone would leave it alive. */
	async kill(): Promise<void> {
		if (this.handle) await this.handle.kill();
	}
}
