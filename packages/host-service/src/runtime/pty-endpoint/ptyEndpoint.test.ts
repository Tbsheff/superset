import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RemoteRuntimeResolver } from "../exec/index.ts";
import type {
	ActivityLease,
	ShellHandle,
	StartShellOptions,
	WorkspaceRuntime,
} from "../seam/index.ts";
import {
	type PtyEndpointSocket,
	type RemotePtyServerMessage,
	RemotePtySession,
} from "./ptyEndpoint.ts";

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const WS_ID = "ws-remote-1";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Records every frame the session sends so a test can assert the wire protocol. */
class FakeSocket implements PtyEndpointSocket {
	readyState = SOCKET_OPEN;
	readonly control: RemotePtyServerMessage[] = [];
	readonly binary: Uint8Array[] = [];
	readonly closes: { code?: number; reason?: string }[] = [];

	send(data: string | Uint8Array<ArrayBuffer>): void {
		if (typeof data === "string") {
			this.control.push(JSON.parse(data) as RemotePtyServerMessage);
		} else {
			this.binary.push(new Uint8Array(data));
		}
	}

	close(code?: number, reason?: string): void {
		this.readyState = SOCKET_CLOSED;
		this.closes.push({ code, reason });
	}

	/** Concatenated UTF-8 decode of every binary frame, for output assertions. */
	outputText(): string {
		const decoder = new TextDecoder("utf-8");
		return this.binary.map((b) => decoder.decode(b, { stream: true })).join("");
	}
}

interface FakeShell extends ShellHandle {
	emitData(chunk: string): void;
	emitExit(exitCode: number): void;
	writes: string[];
	resizes: { cols: number; rows: number }[];
	killed: boolean;
}

function makeFakeShell(): FakeShell {
	const dataCbs = new Set<(chunk: string) => void>();
	const exitCbs = new Set<
		(info: { exitCode: number; signal?: number }) => void
	>();
	const writes: string[] = [];
	const resizes: { cols: number; rows: number }[] = [];
	const shell: FakeShell = {
		surface: { kind: "pty" },
		writes,
		resizes,
		killed: false,
		write(data) {
			writes.push(data);
		},
		resize(cols, rows) {
			resizes.push({ cols, rows });
		},
		onData(cb) {
			dataCbs.add(cb);
			return { dispose: () => dataCbs.delete(cb) };
		},
		onExit(cb) {
			exitCbs.add(cb);
			return { dispose: () => exitCbs.delete(cb) };
		},
		async kill() {
			shell.killed = true;
		},
		emitData(chunk) {
			for (const cb of dataCbs) cb(chunk);
		},
		emitExit(exitCode) {
			for (const cb of exitCbs) cb({ exitCode });
		},
	};
	return shell;
}

interface FakeLease extends ActivityLease {
	starts: number;
	releases: number;
}

/**
 * In-memory `ActivityLease`. `starts` counts how many times the runtime handed
 * it out (the runtime starts the heartbeat on first `activityLease()`), and
 * `releases` how many times the session released it.
 */
function makeFakeLease(): FakeLease {
	const lease: FakeLease = {
		starts: 0,
		releases: 0,
		async heartbeat() {
			return { ok: true };
		},
		async release() {
			lease.releases += 1;
		},
	};
	return lease;
}

function runtimeWith(
	shell: ShellHandle,
	onStart?: (opts: StartShellOptions) => void,
	lease?: FakeLease,
): WorkspaceRuntime {
	return {
		role: "workspace",
		externalId: "sbx-1",
		async startShell(opts) {
			onStart?.(opts);
			return shell;
		},
		async getDiff() {
			return { statusPorcelain: "", unifiedPatch: "" };
		},
		async exposePreview() {
			return { url: "https://x", tokenScheme: "standard" };
		},
		activityLease() {
			if (!lease) throw new Error("not used");
			lease.starts += 1;
			return lease;
		},
		async getStatus() {
			return { phase: "running" } as never;
		},
		async stop() {},
	};
}

function resolverFor(runtime: WorkspaceRuntime): RemoteRuntimeResolver {
	return {
		resolve: mock(async () => runtime),
		status: async () => ({ kind: "running" }) as const,
	};
}

describe("RemotePtySession", () => {
	let socket: FakeSocket;
	let shell: FakeShell;

	beforeEach(() => {
		socket = new FakeSocket();
		shell = makeFakeShell();
	});

	test("attach: starts a shell and emits exactly one attached frame", async () => {
		const started: StartShellOptions[] = [];
		const runtime = runtimeWith(shell, (o) => started.push(o));
		const session = new RemotePtySession(socket, resolverFor(runtime), WS_ID, {
			cols: 100,
			rows: 40,
		});

		await session.attach();

		expect(socket.control).toEqual([{ type: "attached" }]);
		expect(started).toEqual([{ cols: 100, rows: 40 }]);
		// Idempotent: a second attach must not start another shell or re-emit.
		await session.attach();
		expect(socket.control).toEqual([{ type: "attached" }]);
	});

	test("attach: writes the initial command (newline appended) after attached", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
			{ initialCommand: "bun run dev" },
		);

		await session.attach();

		expect(shell.writes).toEqual(["bun run dev\n"]);
		// The command runs after output is wired so its echo isn't lost.
		expect(socket.control).toEqual([{ type: "attached" }]);
	});

	test("attach: a command already ending in newline is not double-terminated", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
			{ initialCommand: "echo hi\n" },
		);

		await session.attach();

		expect(shell.writes).toEqual(["echo hi\n"]);
	});

	test("attach: no initial command writes nothing to the shell", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);

		await session.attach();

		expect(shell.writes).toEqual([]);
	});

	test("attach: PTY output is delivered as binary UTF-8 frames, not JSON", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();

		shell.emitData("héllo "); // multi-byte glyph to prove UTF-8 encode
		shell.emitData("world");

		expect(socket.binary.length).toBe(2);
		expect(socket.outputText()).toBe("héllo world");
		// Output never rides the control (JSON text) channel.
		expect(socket.control).toEqual([{ type: "attached" }]);
	});

	test("input frame writes to the shell verbatim (caller owns the newline)", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();

		session.handleMessage(JSON.stringify({ type: "input", data: "ls -la\n" }));
		session.handleMessage(JSON.stringify({ type: "input", data: "" }));

		expect(shell.writes).toEqual(["ls -la\n", ""]);
	});

	test("resize frame clamps to the minimum and forwards cols then rows", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();

		session.handleMessage(
			JSON.stringify({ type: "resize", cols: 200, rows: 50 }),
		);
		session.handleMessage(JSON.stringify({ type: "resize", cols: 1, rows: 1 }));

		expect(shell.resizes).toEqual([
			{ cols: 200, rows: 50 },
			{ cols: 20, rows: 5 },
		]);
	});

	test("exit frame fires exactly once and carries the exit code", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();

		shell.emitExit(137);
		shell.emitExit(0); // a second exit must not re-fire

		const exits = socket.control.filter((m) => m.type === "exit");
		expect(exits).toEqual([{ type: "exit", exitCode: 137 }]);
	});

	test("input after exit is dropped", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();
		shell.emitExit(0);

		session.handleMessage(JSON.stringify({ type: "input", data: "echo hi\n" }));

		expect(shell.writes).toEqual([]);
	});

	test("kill terminates the shell and closes the socket cleanly", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();

		session.handleMessage(JSON.stringify({ type: "kill" }));
		await Promise.resolve();
		await Promise.resolve();

		expect(shell.killed).toBe(true);
		expect(socket.readyState).toBe(SOCKET_CLOSED);
		expect(socket.closes[0]?.code).toBe(1000);
	});

	test("dispose detaches without killing the sandbox PTY (reconnect-safe)", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();

		session.dispose();

		expect(shell.killed).toBe(false);
		// After dispose, late PTY output is no longer forwarded.
		shell.emitData("late");
		expect(socket.binary.length).toBe(0);
	});

	test("malformed payload emits an error control frame and keeps the PTY alive", async () => {
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);
		await session.attach();

		session.handleMessage("not json {");

		expect(socket.control).toContainEqual({
			type: "error",
			message: "Invalid remote PTY message payload",
		});
		expect(shell.killed).toBe(false);
	});

	test("resolve failure emits an error frame and closes the socket; no shell started", async () => {
		const resolver: RemoteRuntimeResolver = {
			resolve: mock(async () => {
				throw new Error("no live runtime instance");
			}),
			status: async () => ({ kind: "running" }) as const,
		};
		const session = new RemotePtySession(socket, resolver, WS_ID);

		await session.attach();

		expect(socket.control).toEqual([
			{ type: "error", message: "no live runtime instance" },
		]);
		expect(socket.readyState).toBe(SOCKET_CLOSED);
		expect(socket.closes[0]?.code).toBe(1011);
	});

	test("startShell failure emits an error frame and closes the socket", async () => {
		const runtime: WorkspaceRuntime = {
			...runtimeWith(shell),
			async startShell() {
				throw new Error("sandbox stopped");
			},
		};
		const session = new RemotePtySession(socket, resolverFor(runtime), WS_ID);

		await session.attach();

		expect(socket.control).toEqual([
			{ type: "error", message: "sandbox stopped" },
		]);
		expect(socket.readyState).toBe(SOCKET_CLOSED);
	});

	test("socket closing while startShell is in flight kills the shell and emits nothing", async () => {
		const startGate = deferred<void>();
		const runtime: WorkspaceRuntime = {
			...runtimeWith(shell),
			async startShell() {
				await startGate.promise;
				return shell;
			},
		};
		const session = new RemotePtySession(socket, resolverFor(runtime), WS_ID);

		const attachPromise = session.attach();
		await Promise.resolve(); // let resolve() settle so attach reaches startShell
		// Socket dies mid-attach (slow sandbox boot, user navigated away).
		session.dispose();
		startGate.resolve();
		await attachPromise;

		// Shell came up after detach → it must be killed, and no frames sent.
		expect(socket.control).toEqual([]);
		expect(shell.killed).toBe(true);
	});

	test("socket closing during resolve never starts a shell", async () => {
		const runtime = runtimeWith(shell);
		const startSpy = mock(runtime.startShell.bind(runtime));
		runtime.startShell = startSpy;
		const session = new RemotePtySession(socket, resolverFor(runtime), WS_ID);

		const attachPromise = session.attach();
		// Dispose before resolve settles: the cheap path bails before startShell.
		session.dispose();
		await attachPromise;

		expect(startSpy).not.toHaveBeenCalled();
		expect(socket.control).toEqual([]);
	});

	test("attach starts the keep-alive lease exactly once", async () => {
		const lease = makeFakeLease();
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell, undefined, lease)),
			WS_ID,
		);

		await session.attach();

		expect(lease.starts).toBe(1);
		expect(lease.releases).toBe(0);
	});

	test("dispose releases the lease (bare disconnect stops the heartbeat)", async () => {
		const lease = makeFakeLease();
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell, undefined, lease)),
			WS_ID,
		);
		await session.attach();

		session.dispose();
		await Promise.resolve();

		expect(lease.releases).toBe(1);
	});

	test("kill releases the lease", async () => {
		const lease = makeFakeLease();
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell, undefined, lease)),
			WS_ID,
		);
		await session.attach();

		session.handleMessage(JSON.stringify({ type: "kill" }));
		await Promise.resolve();
		await Promise.resolve();

		expect(lease.releases).toBe(1);
	});

	test("shell exit releases the lease", async () => {
		const lease = makeFakeLease();
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell, undefined, lease)),
			WS_ID,
		);
		await session.attach();

		shell.emitExit(0);
		await Promise.resolve();

		expect(lease.releases).toBe(1);
	});

	test("a lease that throws on acquire does not break attach", async () => {
		// runtimeWith without a lease throws from activityLease(); attach must
		// still emit `attached` and stream output.
		const session = new RemotePtySession(
			socket,
			resolverFor(runtimeWith(shell)),
			WS_ID,
		);

		await session.attach();

		expect(socket.control).toEqual([{ type: "attached" }]);
		shell.emitData("ok");
		expect(socket.outputText()).toBe("ok");
	});
});
