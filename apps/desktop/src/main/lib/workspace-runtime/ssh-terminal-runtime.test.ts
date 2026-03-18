import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

function createMockChannel() {
	const listeners = new Map<string, ((...args: any[]) => void)[]>();
	return {
		on: mock((event: string, cb: (...args: any[]) => void) => {
			const existing = listeners.get(event) || [];
			existing.push(cb);
			listeners.set(event, existing);
		}),
		write: mock((_data: any) => {}),
		close: mock(() => {}),
		setWindow: mock(
			(_rows: number, _cols: number, _height: number, _width: number) => {},
		),
		stderr: {
			on: mock((_event: string, _cb: (...args: any[]) => void) => {}),
		},
		_listeners: listeners,
		_emit: (event: string, ...args: any[]) => {
			const cbs = listeners.get(event) || [];
			for (const cb of cbs) cb(...args);
		},
	};
}

let mockChannel: ReturnType<typeof createMockChannel>;
let mockClient: { shell: ReturnType<typeof mock> };

mock.module("./ssh-connection-manager", () => ({
	getSshConnectionManager: () => ({
		connect: mock(async () => mockClient),
		getStatus: mock(() => "connected"),
	}),
}));

const { SshTerminalRuntime } = await import("./ssh-terminal-runtime");

const hostConfig = {
	id: "host-1",
	hostname: "example.com",
	port: 22,
	username: "user",
	authMethod: "agent" as const,
};

describe("SshTerminalRuntime", () => {
	let runtime: InstanceType<typeof SshTerminalRuntime>;

	beforeEach(() => {
		mockChannel = createMockChannel();
		mockClient = {
			shell: mock((_opts: any, cb: (err: null, ch: any) => void) => {
				cb(null, mockChannel);
			}),
		};
		runtime = new SshTerminalRuntime(hostConfig);
	});

	afterEach(async () => {
		await runtime.cleanup();
	});

	test("capabilities are persistent:false, coldRestore:false", () => {
		expect(runtime.capabilities.persistent).toBe(false);
		expect(runtime.capabilities.coldRestore).toBe(false);
	});

	test("createOrAttach creates a new SSH session", async () => {
		const result = await runtime.createOrAttach({
			paneId: "pane-1",
			workspaceId: "ws-1",
			cols: 80,
			rows: 24,
		});
		expect(result.isNew).toBe(true);
		expect(result.scrollback).toBe("");
		expect(result.wasRecovered).toBe(false);
		expect(mockClient.shell).toHaveBeenCalledTimes(1);
	});

	test("createOrAttach returns isNew:false for existing alive session", async () => {
		await runtime.createOrAttach({
			paneId: "pane-1",
			workspaceId: "ws-1",
		});
		const result = await runtime.createOrAttach({
			paneId: "pane-1",
			workspaceId: "ws-1",
		});
		expect(result.isNew).toBe(false);
		// shell called only once (second call reused existing)
		expect(mockClient.shell).toHaveBeenCalledTimes(1);
	});

	test("write sends data to channel", async () => {
		await runtime.createOrAttach({ paneId: "pane-1", workspaceId: "ws-1" });
		runtime.write({ paneId: "pane-1", data: "hello" });
		expect(mockChannel.write).toHaveBeenCalledWith("hello");
	});

	test("write throws for dead session", () => {
		expect(() => runtime.write({ paneId: "nonexistent", data: "x" })).toThrow(
			"not found or not alive",
		);
	});

	test("resize calls setWindow on channel", async () => {
		await runtime.createOrAttach({
			paneId: "pane-1",
			workspaceId: "ws-1",
			cols: 80,
			rows: 24,
		});
		runtime.resize({ paneId: "pane-1", cols: 120, rows: 40 });
		expect(mockChannel.setWindow).toHaveBeenCalledWith(40, 120, 640, 960);
	});

	test("signal writes Ctrl+C for SIGINT", async () => {
		await runtime.createOrAttach({ paneId: "pane-1", workspaceId: "ws-1" });
		runtime.signal({ paneId: "pane-1", signal: "SIGINT" });
		expect(mockChannel.write).toHaveBeenCalledWith("\x03");
	});

	test("kill closes channel and removes session", async () => {
		await runtime.createOrAttach({ paneId: "pane-1", workspaceId: "ws-1" });
		await runtime.kill({ paneId: "pane-1" });
		expect(mockChannel.close).toHaveBeenCalledTimes(1);
		expect(runtime.getSession("pane-1")).toBeNull();
	});

	test("getSession returns session info", async () => {
		await runtime.createOrAttach({ paneId: "pane-1", workspaceId: "ws-1" });
		const session = runtime.getSession("pane-1");
		expect(session).not.toBeNull();
		expect(session?.isAlive).toBe(true);
		expect(typeof session?.lastActive).toBe("number");
	});

	test("getSession returns null for unknown pane", () => {
		expect(runtime.getSession("unknown-pane")).toBeNull();
	});

	test("clearScrollback writes ANSI clear sequence", async () => {
		await runtime.createOrAttach({ paneId: "pane-1", workspaceId: "ws-1" });
		// Reset write mock count after createOrAttach (may write cd command)
		mockChannel.write.mockClear();
		runtime.clearScrollback({ paneId: "pane-1" });
		expect(mockChannel.write).toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");
	});

	test("killByWorkspaceId kills matching sessions", async () => {
		mockChannel = createMockChannel();
		mockClient = {
			shell: mock((_opts: any, cb: (err: null, ch: any) => void) => {
				cb(null, mockChannel);
			}),
		};
		await runtime.createOrAttach({
			paneId: "pane-1",
			workspaceId: "ws-target",
		});

		const ch2 = createMockChannel();
		mockClient = {
			shell: mock((_opts: any, cb: (err: null, ch: any) => void) => {
				cb(null, ch2);
			}),
		};
		await runtime.createOrAttach({ paneId: "pane-2", workspaceId: "ws-other" });

		const result = await runtime.killByWorkspaceId("ws-target");
		expect(result.killed).toBe(1);
		expect(result.failed).toBe(0);
		expect(runtime.getSession("pane-1")).toBeNull();
		expect(runtime.getSession("pane-2")).not.toBeNull();
	});

	test("getSessionCountByWorkspaceId counts alive sessions", async () => {
		await runtime.createOrAttach({ paneId: "pane-1", workspaceId: "ws-1" });

		const ch2 = createMockChannel();
		mockClient = {
			shell: mock((_opts: any, cb: (err: null, ch: any) => void) => {
				cb(null, ch2);
			}),
		};
		await runtime.createOrAttach({ paneId: "pane-2", workspaceId: "ws-1" });

		const ch3 = createMockChannel();
		mockClient = {
			shell: mock((_opts: any, cb: (err: null, ch: any) => void) => {
				cb(null, ch3);
			}),
		};
		await runtime.createOrAttach({ paneId: "pane-3", workspaceId: "ws-other" });

		const count = await runtime.getSessionCountByWorkspaceId("ws-1");
		expect(count).toBe(2);
	});

	test("ackColdRestore is a no-op", () => {
		// Should not throw and has no observable effect
		expect(() => runtime.ackColdRestore("pane-1")).not.toThrow();
	});

	test("cleanup kills all sessions", async () => {
		await runtime.createOrAttach({ paneId: "pane-1", workspaceId: "ws-1" });

		const ch2 = createMockChannel();
		mockClient = {
			shell: mock((_opts: any, cb: (err: null, ch: any) => void) => {
				cb(null, ch2);
			}),
		};
		await runtime.createOrAttach({ paneId: "pane-2", workspaceId: "ws-1" });

		await runtime.cleanup();

		expect(runtime.getSession("pane-1")).toBeNull();
		expect(runtime.getSession("pane-2")).toBeNull();
	});
});
