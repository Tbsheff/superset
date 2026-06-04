import { describe, expect, mock, test } from "bun:test";

const createTerminalSessionInternal = mock();
const disposeSession = mock();

mock.module("../../../terminal/terminal.ts", () => ({
	createTerminalSessionInternal,
	disposeSession,
}));

const { LocalPtyTransport } = await import("./LocalPtyTransport.ts");

interface PtySpies {
	write: ReturnType<typeof mock>;
	writeBytes: ReturnType<typeof mock>;
	resize: ReturnType<typeof mock>;
	kill: ReturnType<typeof mock>;
	onData: ReturnType<typeof mock>;
	onExit: ReturnType<typeof mock>;
}

function makeSession(pid: number): { pty: PtySpies & { pid: number } } {
	return {
		pty: {
			pid,
			write: mock(),
			writeBytes: mock(),
			resize: mock(),
			kill: mock(async () => {}),
			onData: mock(() => ({ dispose: () => {} })),
			onExit: mock(() => ({ dispose: () => {} })),
		},
	};
}

const fakeDb = {} as never;

describe("LocalPtyTransport", () => {
	test("forwards startShell options unchanged into createTerminalSessionInternal", async () => {
		createTerminalSessionInternal.mockReset();
		createTerminalSessionInternal.mockResolvedValueOnce(makeSession(4242));

		const transport = new LocalPtyTransport(fakeDb);
		await transport.startShell({
			terminalId: "t-1",
			workspaceId: "ws-1",
			initialCommand: "setup-a && setup-b",
			cwd: "/work/dir",
			listed: false,
			cols: 100,
			rows: 30,
		});

		expect(createTerminalSessionInternal).toHaveBeenCalledTimes(1);
		const passed = createTerminalSessionInternal.mock.calls[0]?.[0];
		expect(passed).toMatchObject({
			terminalId: "t-1",
			workspaceId: "ws-1",
			initialCommand: "setup-a && setup-b",
			cwd: "/work/dir",
			listed: false,
			cols: 100,
			rows: 30,
		});
	});

	test("returned handle exposes the session pid and delegates to the pty", async () => {
		const session = makeSession(99);
		createTerminalSessionInternal.mockReset();
		createTerminalSessionInternal.mockResolvedValueOnce(session);

		const transport = new LocalPtyTransport(fakeDb);
		const handle = await transport.startShell({
			terminalId: "t-2",
			workspaceId: "ws-2",
		});
		if ("error" in handle) throw new Error("expected a handle, got an error");

		expect(handle.pid).toBe(99);

		handle.write("ls\n");
		handle.resize(120, 40);
		await handle.kill();

		expect(session.pty.write).toHaveBeenCalledWith("ls\n");
		expect(session.pty.resize).toHaveBeenCalledWith(120, 40);
		expect(session.pty.kill).toHaveBeenCalledTimes(1);
	});

	test("propagates an error result from the session without throwing", async () => {
		createTerminalSessionInternal.mockReset();
		createTerminalSessionInternal.mockResolvedValueOnce({
			error: "Workspace not found",
		});

		const transport = new LocalPtyTransport(fakeDb);
		const handle = await transport.startShell({
			terminalId: "t-3",
			workspaceId: "ws-missing",
		});

		expect("error" in handle && handle.error).toBe("Workspace not found");
	});

	test("dispose delegates to disposeSession", () => {
		disposeSession.mockReset();
		const transport = new LocalPtyTransport(fakeDb);
		transport.dispose("t-4");
		expect(disposeSession).toHaveBeenCalledWith("t-4", fakeDb);
	});
});
