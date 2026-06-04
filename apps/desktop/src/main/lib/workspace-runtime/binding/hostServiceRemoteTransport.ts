/**
 * Host-service-backed Remote PTY Transport (desktop main)
 *
 * Produces the `RemotePtyTransportFactory` the registry injects for
 * `runtimeKind === "remote"` workspaces. Each transport drives ONE remote PTY
 * over the existing host-service connection — the same `127.0.0.1:<port>` +
 * `Bearer <secret>` connection the coordinator already manages
 * (`main/lib/host-service-coordinator.ts`) — and adapts the host-service
 * `DaytonaPtyTransport` protocol to the desktop `RemotePtyTransport` seam.
 *
 * The desktop main bundle must NOT import `@daytonaio/sdk`; the real PTY runs
 * inside the host-service process. This module talks to it purely over the wire,
 * so the SDK never enters Electron's main bundle.
 *
 * Protocol contract (mirrors `DaytonaPtyTransport`):
 * - output: server frames carry decoded UTF-8 text; the host owns the streaming
 *   decode so a glyph never splits across two frames. We forward strings as-is.
 * - input: `{ type: "input", data }` — caller owns the trailing newline.
 * - interrupt: a raw Ctrl+C byte (``) as input, never a string, so it is
 *   not line-buffered.
 * - resize: `{ type: "resize", cols, rows }`, cols then rows.
 * - exit: a single `{ type: "exit", exitCode }` frame. Exit is a state
 *   transition, NOT stream completion — onExit fires once and the channel is
 *   left for the runtime to tear down; the runtime never completes the
 *   renderer's observable.
 * - kill vs disconnect: `kill()` sends `{ type: "kill" }` so the host TERMINATES
 *   the PTY; a bare socket close would leave the sandbox process running.
 */

import type { RemotePtyTransport, RemotePtyTransportFactory } from "../remote";

/** The host-service connection coordinates resolve per organization. */
export interface HostServiceRemoteConnection {
	/** Loopback origin, e.g. `http://127.0.0.1:48123`. */
	origin: string;
	/** Per-instance PSK; sent as `?token=` on the WS upgrade. */
	secret: string;
}

/**
 * Minimal duplex channel the transport drives. Production binds this to a real
 * WebSocket to the host-service; tests inject an in-memory fake. Output frames
 * are pre-decoded strings; control frames are parsed JSON objects.
 */
export interface RemotePtyChannel {
	/** Resolves once the host has attached the PTY and the channel is writable. */
	ready: Promise<void>;
	onOutput(cb: (chunk: string) => void): void;
	onControl(cb: (message: RemotePtyControlMessage) => void): void;
	send(message: RemotePtyClientMessage): void;
	close(): void;
}

/** Control frames the host sends back to the desktop. */
export type RemotePtyControlMessage =
	| { type: "attached" }
	| { type: "exit"; exitCode: number }
	| { type: "error"; message: string };

/** Frames the desktop sends to the host. */
export type RemotePtyClientMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "kill" };

/** Raw Ctrl+C byte as a string payload, matching DaytonaPtyTransport. */
const CTRL_C = "";

export interface HostServiceRemoteTransportDeps {
	/**
	 * Resolves the live host-service connection for a workspace. Returns null
	 * when the workspace's host-service is not running, in which case opening the
	 * transport throws rather than silently dropping output.
	 */
	resolveConnection: (
		workspaceId: string,
	) => HostServiceRemoteConnection | null;
	/**
	 * Opens the duplex channel to the host-service remote PTY endpoint.
	 * Injected so the WebSocket dependency stays out of this module (the main
	 * bundle has no `ws` package) and so tests drive an in-memory channel.
	 */
	openChannel: (args: {
		connection: HostServiceRemoteConnection;
		workspaceId: string;
		paneId: string;
	}) => RemotePtyChannel;
}

class HostServiceRemotePtyTransport implements RemotePtyTransport {
	private channel: RemotePtyChannel | null = null;
	private readonly dataCbs = new Set<(chunk: string) => void>();
	private exitCb:
		| ((info: { exitCode: number; error?: string }) => void)
		| null = null;
	private exited = false;

	constructor(
		private readonly deps: HostServiceRemoteTransportDeps,
		private readonly workspaceId: string,
		private readonly paneId: string,
	) {}

	onData(cb: (chunk: string) => void): { dispose(): void } {
		this.dataCbs.add(cb);
		return {
			dispose: () => {
				this.dataCbs.delete(cb);
			},
		};
	}

	async start(opts: {
		cols: number;
		rows: number;
		cwd?: string;
		envs?: Record<string, string>;
	}): Promise<void> {
		const connection = this.deps.resolveConnection(this.workspaceId);
		if (!connection) {
			throw new Error(
				`host-service-remote-pty: no running host-service connection for workspace ${this.workspaceId}`,
			);
		}

		const channel = this.deps.openChannel({
			connection,
			workspaceId: this.workspaceId,
			paneId: this.paneId,
		});
		this.channel = channel;

		channel.onOutput((chunk) => {
			if (chunk.length === 0) return;
			for (const cb of this.dataCbs) cb(chunk);
		});

		channel.onControl((message) => {
			if (message.type === "exit") {
				this.handleExit({ exitCode: message.exitCode });
				return;
			}
			if (message.type === "error") {
				this.handleExit({ exitCode: 1, error: message.message });
			}
		});

		await channel.ready;
		// The host opened the PTY at a default size; push the renderer's real
		// dimensions before the first output so reflow matches the local path.
		channel.send({ type: "resize", cols: opts.cols, rows: opts.rows });
	}

	private handleExit(info: { exitCode: number; error?: string }): void {
		// Exit is reported exactly once. Subsequent control frames (or a late
		// socket close) must not re-fire it, and the runtime — not this transport
		// — decides whether to complete any renderer observable.
		if (this.exited) return;
		this.exited = true;
		this.exitCb?.(info);
	}

	write(data: string): Promise<void> {
		this.requireChannel().send({ type: "input", data });
		return Promise.resolve();
	}

	signalInterrupt(): Promise<void> {
		this.requireChannel().send({ type: "input", data: CTRL_C });
		return Promise.resolve();
	}

	resize(cols: number, rows: number): Promise<unknown> {
		this.requireChannel().send({ type: "resize", cols, rows });
		return Promise.resolve();
	}

	onExit(cb: (info: { exitCode: number; error?: string }) => void): void {
		this.exitCb = cb;
	}

	kill(): Promise<void> {
		const channel = this.channel;
		if (!channel) return Promise.resolve();
		// Send kill BEFORE closing: a bare close only disconnects this client and
		// leaves the sandbox PTY running. The host terminates the process on kill.
		channel.send({ type: "kill" });
		channel.close();
		this.channel = null;
		return Promise.resolve();
	}

	private requireChannel(): RemotePtyChannel {
		if (!this.channel) {
			throw new Error(
				`host-service-remote-pty: pane ${this.paneId} not started; call start() first`,
			);
		}
		return this.channel;
	}
}

/**
 * Builds the `RemotePtyTransportFactory` the registry injects. The factory is
 * cheap and lazy: it returns a transport object but opens no connection until
 * `start()` is called (so resolving a remote runtime never eagerly connects).
 */
export function createHostServiceRemoteTransportFactory(
	deps: HostServiceRemoteTransportDeps,
): RemotePtyTransportFactory {
	return ({ workspaceId, paneId }) =>
		new HostServiceRemotePtyTransport(deps, workspaceId, paneId);
}
