import type { NodeWebSocket } from "@hono/node-ws";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { HostDb } from "../../db/index.ts";
import { workspaces } from "../../db/schema.ts";
import type { EventBus } from "../../events/index.ts";
import type { HostServiceContext } from "../../types.ts";
import type { TokenMinter } from "../adapters/daytona/types.ts";
import {
	buildRemoteRuntimeResolver,
	type RemoteRuntimeResolver,
	takeRemoteInitialCommand,
} from "../exec/index.ts";
import type { GitFactory } from "../git/index.ts";
import type {
	ActivityLease,
	ShellHandle,
	WorkspaceRuntime,
} from "../seam/index.ts";

/**
 * Host-service `/runtime/:workspaceId/pty/:paneId` WebSocket endpoint.
 *
 * Bridges a desktop `HostServiceRemoteTransport` (apps/desktop) to the live
 * `DaytonaWorkspaceRuntime` for a remote workspace. The desktop opens this
 * socket per pane; the host owns the in-sandbox PTY via the resolved runtime's
 * `startShell`.
 *
 * Wire protocol (pinned to the desktop's `RemotePtyControlMessage` /
 * `RemotePtyClientMessage`):
 *   - output: PTY bytes as BINARY frames. The shell handle hands us already-
 *     decoded UTF-8 strings (the runtime's `TextDecoder` owns boundary
 *     stitching), so we re-encode to UTF-8 bytes here — the desktop pipes the
 *     ArrayBuffer back through its own streaming `TextDecoder`.
 *   - control out (JSON text): `{ type: "attached" }`, `{ type: "exit",
 *     exitCode }`, `{ type: "error", message }`.
 *   - control in (JSON text): `{ type: "input", data }`,
 *     `{ type: "resize", cols, rows }`, `{ type: "kill" }`.
 *
 * Auth is applied at the route level in `app.ts` (`wsAuth` on `/runtime/*`),
 * matching `/terminal/*` and `/events`.
 */

const SOCKET_OPEN = 1;

const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 32;
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;

/** Control frames the host sends to the desktop. Mirrors the desktop's `RemotePtyControlMessage`. */
export type RemotePtyServerMessage =
	| { type: "attached" }
	| { type: "exit"; exitCode: number }
	| { type: "error"; message: string };

/** Control frames the desktop sends to the host. Mirrors the desktop's `RemotePtyClientMessage`. */
export type RemotePtyClientMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "kill" };

/**
 * The slice of a WebSocket the session drives. `send` accepts strings (JSON
 * control) or `Uint8Array<ArrayBuffer>` (binary PTY output); `raw`/`readyState`
 * mirror hono's `WSContext`. Tests inject an in-memory implementation.
 */
export interface PtyEndpointSocket {
	send(data: string | Uint8Array<ArrayBuffer>): void;
	close(code?: number, reason?: string): void;
	readyState: number;
}

const utf8Encoder = new TextEncoder();

// All bytes we send are ArrayBuffer-backed at runtime; the cast narrows the
// loose default `Uint8Array<ArrayBufferLike>`.
function asArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return bytes as Uint8Array<ArrayBuffer>;
}

function sendControl(
	socket: PtyEndpointSocket,
	message: RemotePtyServerMessage,
): void {
	if (socket.readyState !== SOCKET_OPEN) return;
	socket.send(JSON.stringify(message));
}

function sendOutput(socket: PtyEndpointSocket, chunk: string): void {
	if (socket.readyState !== SOCKET_OPEN) return;
	if (chunk.length === 0) return;
	socket.send(asArrayBufferBytes(utf8Encoder.encode(chunk)));
}

function normalizeDimension(
	value: number | null | undefined,
	min: number,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.floor(value));
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Drives one remote PTY over a single socket. Construct it on socket open, call
 * `attach()` to resolve the runtime + start the shell, feed it client frames via
 * `handleMessage`, and `dispose()` on socket close. The shell handle is the
 * single owner of the in-sandbox PTY; `kill()` terminates the process, a bare
 * close (no `kill`) leaves the sandbox PTY running for reconnect.
 */
export class RemotePtySession {
	private shell: ShellHandle | null = null;
	private lease: ActivityLease | null = null;
	private dataDisposer: { dispose(): void } | null = null;
	private exitDisposer: { dispose(): void } | null = null;
	private exited = false;
	private attaching = false;
	private detached = false;

	constructor(
		private readonly socket: PtyEndpointSocket,
		private readonly resolver: RemoteRuntimeResolver,
		private readonly workspaceId: string,
		private readonly opts: {
			cols?: number;
			rows?: number;
			/**
			 * Command to write into the shell immediately after it starts. Carries
			 * a preset / Run / agent launch's command into the lazily-created remote
			 * shell (local panes write this via the daemon's initialCommand instead).
			 * The caller consumes it once so a reconnect doesn't re-run it.
			 */
			initialCommand?: string;
		} = {},
	) {}

	/**
	 * Resolves the workspace's live runtime, starts a shell, wires output + exit,
	 * then emits `{ type: "attached" }`. On any failure emits `{ type: "error" }`
	 * and closes the socket. Idempotent: a second call while attaching is a no-op.
	 */
	async attach(): Promise<void> {
		if (this.attaching || this.shell || this.detached) return;
		this.attaching = true;

		let runtime: WorkspaceRuntime;
		try {
			runtime = await this.resolver.resolve(this.workspaceId);
		} catch (error) {
			this.fail(describeError(error));
			return;
		}

		// The socket may have closed while resolving (slow Daytona reconnect, user
		// navigated away). Bail before spending a PTY on a dead socket.
		if (this.detached || this.socket.readyState !== SOCKET_OPEN) {
			this.attaching = false;
			return;
		}

		let shell: ShellHandle;
		try {
			shell = await runtime.startShell({
				cols: normalizeDimension(
					this.opts.cols,
					MIN_TERMINAL_COLS,
					DEFAULT_TERMINAL_COLS,
				),
				rows: normalizeDimension(
					this.opts.rows,
					MIN_TERMINAL_ROWS,
					DEFAULT_TERMINAL_ROWS,
				),
			});
		} catch (error) {
			this.fail(describeError(error));
			return;
		}

		if (this.detached) {
			await shell.kill().catch(() => {});
			this.attaching = false;
			return;
		}

		this.shell = shell;
		this.attaching = false;

		// Daytona auto-stops the sandbox after its idle interval and preview/PTY
		// traffic does NOT count as activity, so the lease heartbeat is the only
		// thing keeping a live session alive. Start it on attach; release on
		// detach/exit/kill so a torn-down session leaks no keep-alive timer.
		try {
			this.lease = runtime.activityLease();
		} catch {
			// A runtime that can't lease (or already leasing) is non-fatal — the
			// session still streams; it just risks idle auto-stop.
			this.lease = null;
		}

		this.dataDisposer = shell.onData((chunk) => {
			sendOutput(this.socket, chunk);
		});
		this.exitDisposer = shell.onExit(({ exitCode }) => {
			this.handleExit(exitCode);
		});

		sendControl(this.socket, { type: "attached" });

		// Run the launch command (preset / Run / agent) now that output is wired.
		// The sandbox PTY buffers stdin until the shell reads it, so writing
		// immediately is safe — same as the local `queueInitialCommand` and
		// `runWorkspaceCommand`, neither of which gates on shell readiness.
		const initialCommand = this.opts.initialCommand;
		if (initialCommand) {
			try {
				shell.write(
					initialCommand.endsWith("\n")
						? initialCommand
						: `${initialCommand}\n`,
				);
			} catch {
				// A write to a torn-down sandbox PTY surfaces on the next op; the
				// runtime's exit handling owns teardown.
			}
		}
	}

	/**
	 * Parses + applies one client control frame. Malformed payloads emit an
	 * `error` control message rather than tearing down the PTY. Input/resize sent
	 * before `attached` (or after `exit`) are dropped.
	 */
	handleMessage(raw: unknown): void {
		let message: RemotePtyClientMessage;
		try {
			message = JSON.parse(String(raw)) as RemotePtyClientMessage;
		} catch {
			sendControl(this.socket, {
				type: "error",
				message: "Invalid remote PTY message payload",
			});
			return;
		}

		if (message.type === "kill") {
			void this.kill();
			return;
		}

		const shell = this.shell;
		if (!shell || this.exited) return;

		if (message.type === "input") {
			try {
				shell.write(message.data);
			} catch {
				// A write to a torn-down sandbox PTY surfaces on the next op; the
				// runtime's exit handling owns teardown.
			}
			return;
		}

		if (message.type === "resize") {
			const cols = normalizeDimension(
				message.cols,
				MIN_TERMINAL_COLS,
				DEFAULT_TERMINAL_COLS,
			);
			const rows = normalizeDimension(
				message.rows,
				MIN_TERMINAL_ROWS,
				DEFAULT_TERMINAL_ROWS,
			);
			try {
				shell.resize(cols, rows);
			} catch {
				// best-effort; same rationale as input
			}
		}
	}

	/** Terminates the in-sandbox PTY and closes the socket. Safe to call repeatedly. */
	async kill(): Promise<void> {
		const shell = this.shell;
		this.teardownListeners();
		this.releaseLease();
		this.shell = null;
		if (shell) await shell.kill().catch(() => {});
		if (this.socket.readyState === SOCKET_OPEN) {
			this.socket.close(1000, "remote PTY killed");
		}
	}

	/**
	 * Called on socket close/error. Detaches listeners but DOES NOT kill the PTY —
	 * a bare disconnect leaves the sandbox shell running so the desktop can
	 * reconnect; only an explicit `{ type: "kill" }` terminates it. The keep-alive
	 * lease IS released: this connection no longer drives activity, and a
	 * reconnect re-arms a fresh lease on its own attach.
	 */
	dispose(): void {
		this.detached = true;
		this.teardownListeners();
		this.releaseLease();
	}

	private teardownListeners(): void {
		if (this.dataDisposer) {
			try {
				this.dataDisposer.dispose();
			} catch {
				// best-effort
			}
			this.dataDisposer = null;
		}
		if (this.exitDisposer) {
			try {
				this.exitDisposer.dispose();
			} catch {
				// best-effort
			}
			this.exitDisposer = null;
		}
	}

	private releaseLease(): void {
		if (!this.lease) return;
		const lease = this.lease;
		this.lease = null;
		void lease.release().catch(() => {});
	}

	private handleExit(exitCode: number): void {
		if (this.exited) return;
		this.exited = true;
		this.teardownListeners();
		this.releaseLease();
		sendControl(this.socket, { type: "exit", exitCode });
	}

	private fail(message: string): void {
		this.attaching = false;
		sendControl(this.socket, { type: "error", message });
		if (this.socket.readyState === SOCKET_OPEN) {
			this.socket.close(1011, message);
		}
	}
}

export interface RegisterRuntimePtyRouteOptions {
	app: Hono;
	db: HostDb;
	git: GitFactory;
	eventBus: EventBus;
	mintRepoScopedToken?: TokenMinter;
	upgradeWebSocket: NodeWebSocket["upgradeWebSocket"];
	/**
	 * Builds the per-connection remote runtime resolver. Defaults to the
	 * production `buildRemoteRuntimeResolver` (Daytona via the registry adapter);
	 * tests inject a fake that resolves an in-memory runtime with no network.
	 */
	resolverFactory?: () => Promise<RemoteRuntimeResolver>;
}

/**
 * Registers `GET /runtime/:workspaceId/pty/:paneId`. The route is upgraded to a
 * WebSocket; `wsAuth` (applied to `/runtime/*` in `app.ts`) gates it before this
 * handler runs. Each connection gets its own `RemotePtySession`.
 */
export function registerRuntimePtyRoute({
	app,
	db,
	git,
	eventBus,
	mintRepoScopedToken,
	upgradeWebSocket,
	resolverFactory,
}: RegisterRuntimePtyRouteOptions): void {
	// buildRemoteRuntimeResolver only reads db/git/eventBus/mintRepoScopedToken
	// off the context (it dynamically imports env for the SDK + store itself).
	// The route never has a full HostServiceContext, so pass the slice it needs.
	const resolverContext: Pick<
		HostServiceContext,
		"db" | "git" | "eventBus" | "mintRepoScopedToken"
	> = { db, git, eventBus, mintRepoScopedToken };
	const buildResolver =
		resolverFactory ??
		(() => buildRemoteRuntimeResolver(resolverContext as HostServiceContext));

	app.get(
		"/runtime/:workspaceId/pty/:paneId",
		upgradeWebSocket((c) => {
			const workspaceId = c.req.param("workspaceId") ?? "";
			let session: RemotePtySession | null = null;

			return {
				onOpen: (_event, ws) => {
					const socket = ws as unknown as PtyEndpointSocket;
					if (!workspaceId) {
						sendControl(socket, {
							type: "error",
							message: "Missing workspaceId",
						});
						socket.close(1011, "Missing workspaceId");
						return;
					}

					const workspace = db.query.workspaces
						.findFirst({ where: eq(workspaces.id, workspaceId) })
						.sync();
					if (!workspace) {
						sendControl(socket, {
							type: "error",
							message: `Workspace not found: ${workspaceId}`,
						});
						socket.close(1011, "Workspace not found");
						return;
					}
					if (workspace.runtimeKind !== "remote") {
						sendControl(socket, {
							type: "error",
							message: `Workspace ${workspaceId} is not a remote runtime.`,
						});
						socket.close(1011, "Not a remote runtime");
						return;
					}

					void (async () => {
						let resolver: RemoteRuntimeResolver;
						try {
							resolver = await buildResolver();
						} catch (error) {
							sendControl(socket, {
								type: "error",
								message: describeError(error),
							});
							socket.close(1011, "Resolver build failed");
							return;
						}
						const cols = Number(c.req.query("cols"));
						const rows = Number(c.req.query("rows"));
						// The renderer passes the pane's terminalId so we can claim the
						// initial command `createSession` stashed for this launch. Consumed
						// once here (delete-on-read) so a reconnect's fresh shell won't
						// re-run it.
						const paneTerminalId = c.req.query("terminalId");
						const initialCommand = paneTerminalId
							? takeRemoteInitialCommand(paneTerminalId)
							: undefined;
						session = new RemotePtySession(socket, resolver, workspaceId, {
							...(Number.isFinite(cols) ? { cols } : {}),
							...(Number.isFinite(rows) ? { rows } : {}),
							...(initialCommand ? { initialCommand } : {}),
						});
						await session.attach();
					})().catch((error) => {
						sendControl(socket, {
							type: "error",
							message: describeError(error),
						});
						if (socket.readyState === SOCKET_OPEN) {
							socket.close(1011, "Internal remote PTY attach error");
						}
					});
				},

				onMessage: (event, _ws) => {
					session?.handleMessage(event.data);
				},

				onClose: () => {
					session?.dispose();
				},

				onError: () => {
					session?.dispose();
				},
			};
		}),
	);
}
