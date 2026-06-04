import { describe, expect, test } from "bun:test";
import type { CreateSessionParams } from "../../terminal/types";
import {
	type RemotePtyTransport,
	type RemotePtyTransportFactory,
	RemoteWorkspaceRuntime,
} from "./RemoteWorkspaceRuntime";

interface FakeTransport extends RemotePtyTransport {
	emitData(chunk: string): void;
	triggerExit(info: { exitCode: number; error?: string }): void;
	readonly writes: string[];
	readonly resizes: Array<[number, number]>;
	readonly events: string[];
	started: boolean;
}

function makeFactory(): {
	factory: RemotePtyTransportFactory;
	created: Array<{
		args: { workspaceId: string; paneId: string };
		t: FakeTransport;
	}>;
} {
	const created: Array<{
		args: { workspaceId: string; paneId: string };
		t: FakeTransport;
	}> = [];
	const factory: RemotePtyTransportFactory = (args) => {
		let dataCb: ((chunk: string) => void) | null = null;
		let exitCb: ((info: { exitCode: number; error?: string }) => void) | null =
			null;
		const t: FakeTransport = {
			writes: [],
			resizes: [],
			events: [],
			started: false,
			onData(cb) {
				dataCb = cb;
				return {
					dispose: () => {
						dataCb = null;
						t.events.push("dispose");
					},
				};
			},
			async start() {
				t.started = true;
				t.events.push("start");
			},
			async write(data) {
				t.writes.push(data);
			},
			async signalInterrupt() {
				t.events.push("signalInterrupt");
			},
			async resize(cols, rows) {
				t.resizes.push([cols, rows]);
				return undefined;
			},
			onExit(cb) {
				exitCb = cb;
			},
			async kill() {
				t.events.push("kill");
			},
			emitData(chunk) {
				dataCb?.(chunk);
			},
			triggerExit(info) {
				exitCb?.(info);
			},
		};
		created.push({ args, t });
		return t;
	};
	return { factory, created };
}

function params(over: Partial<CreateSessionParams> = {}): CreateSessionParams {
	return {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
		...over,
	};
}

describe("RemoteWorkspaceRuntime", () => {
	test("exposes non-persistent, no-cold-restore capabilities", () => {
		const { factory } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		expect(runtime.id).toBe("remote");
		expect(runtime.capabilities.terminal).toEqual({
			persistent: false,
			coldRestore: false,
		});
	});

	test("createOrAttach starts a transport scoped to the (workspace, pane)", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		const result = await runtime.terminal.createOrAttach(
			params({ paneId: "p9", workspaceId: "wsX", cols: 100, rows: 30 }),
		);
		expect(result).toEqual({
			isNew: true,
			scrollback: "",
			wasRecovered: false,
		});
		expect(created).toHaveLength(1);
		expect(created[0]?.args).toEqual({ workspaceId: "wsX", paneId: "p9" });
		expect(created[0]?.t.started).toBe(true);
	});

	test("re-attaching an alive pane reuses the transport (isNew=false)", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		await runtime.terminal.createOrAttach(params());
		const second = await runtime.terminal.createOrAttach(params());
		expect(second.isNew).toBe(false);
		expect(created).toHaveLength(1);
	});

	test("emits decoded output on the per-pane data event", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		const out: string[] = [];
		runtime.terminal.on("data:pane-1", (chunk: string) => out.push(chunk));
		await runtime.terminal.createOrAttach(params());
		created[0]?.t.emitData("hello ");
		created[0]?.t.emitData("world");
		expect(out).toEqual(["hello ", "world"]);
	});

	test("on exit it emits exit:<paneId> and NEVER completes the stream", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		const exits: Array<{ code: number; reason?: string }> = [];
		const afterExitData: string[] = [];
		runtime.terminal.on(
			"exit:pane-1",
			(exitCode: number, _signal?: number, reason?: string) =>
				exits.push({ code: exitCode, reason }),
		);
		runtime.terminal.on("data:pane-1", (chunk: string) =>
			afterExitData.push(chunk),
		);
		await runtime.terminal.createOrAttach(params());

		created[0]?.t.triggerExit({ exitCode: 0 });
		expect(exits).toEqual([{ code: 0, reason: "exited" }]);

		// The data listener is still attached after exit (no completion). A pane is
		// reusable across restarts, so the subscription must survive an exit.
		expect(runtime.terminal.listenerCount("data:pane-1")).toBe(1);
		runtime.terminal.emit("data:pane-1", "post-exit");
		expect(afterExitData).toEqual(["post-exit"]);
	});

	test("exit with an error also emits a per-pane error event", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		const errors: Array<{ error: string; code?: string }> = [];
		runtime.terminal.on(
			"error:pane-1",
			(payload: { error: string; code?: string }) => errors.push(payload),
		);
		await runtime.terminal.createOrAttach(params());
		created[0]?.t.triggerExit({ exitCode: 1, error: "boom" });
		expect(errors).toEqual([{ error: "boom", code: "SUBPROCESS_ERROR" }]);
	});

	test("write forwards verbatim to the transport", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		await runtime.terminal.createOrAttach(params());
		runtime.terminal.write({ paneId: "pane-1", data: "ls\n" });
		expect(created[0]?.t.writes).toEqual(["ls\n"]);
	});

	test("write to an unknown pane throws not-found", async () => {
		const { factory } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		expect(() =>
			runtime.terminal.write({ paneId: "ghost", data: "x" }),
		).toThrow(/not found or not alive/);
	});

	test("resize and signal forward to the transport", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		await runtime.terminal.createOrAttach(params());
		runtime.terminal.resize({ paneId: "pane-1", cols: 120, rows: 40 });
		runtime.terminal.signal({ paneId: "pane-1" });
		expect(created[0]?.t.resizes).toEqual([[120, 40]]);
		expect(created[0]?.t.events).toContain("signalInterrupt");
	});

	test("kill terminates the transport, disposes the stream, and drops the session", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		await runtime.terminal.createOrAttach(params());
		await runtime.terminal.kill({ paneId: "pane-1" });
		expect(created[0]?.t.events).toContain("kill");
		expect(created[0]?.t.events).toContain("dispose");
		expect(runtime.terminal.getSession("pane-1")).toBeNull();
	});

	test("getSession reports liveness, cwd, and lastActive", async () => {
		const { factory } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		await runtime.terminal.createOrAttach(params({ cwd: "/work" }));
		const info = runtime.terminal.getSession("pane-1");
		expect(info?.isAlive).toBe(true);
		expect(info?.cwd).toBe("/work");
		expect(typeof info?.lastActive).toBe("number");
	});

	test("killByWorkspaceId only kills panes of the target workspace", async () => {
		const { factory } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		await runtime.terminal.createOrAttach(
			params({ paneId: "a", workspaceId: "ws-1" }),
		);
		await runtime.terminal.createOrAttach(
			params({ paneId: "b", workspaceId: "ws-1" }),
		);
		await runtime.terminal.createOrAttach(
			params({ paneId: "c", workspaceId: "ws-2" }),
		);
		const res = await runtime.terminal.killByWorkspaceId("ws-1");
		expect(res).toEqual({ killed: 2, failed: 0 });
		expect(await runtime.terminal.getSessionCountByWorkspaceId("ws-1")).toBe(0);
		expect(await runtime.terminal.getSessionCountByWorkspaceId("ws-2")).toBe(1);
	});

	test("management.listSessions reflects live remote panes", async () => {
		const { factory } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		await runtime.terminal.createOrAttach(
			params({ paneId: "p", workspaceId: "w" }),
		);
		const { sessions } = await runtime.terminal.management.listSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: "p",
			paneId: "p",
			workspaceId: "w",
			isAlive: true,
		});
	});

	test("cleanup kills every session and clears listeners", async () => {
		const { factory, created } = makeFactory();
		const runtime = new RemoteWorkspaceRuntime(factory);
		runtime.terminal.on("data:pane-1", () => {});
		await runtime.terminal.createOrAttach(params());
		await runtime.terminal.cleanup();
		expect(created[0]?.t.events).toContain("kill");
		expect(runtime.terminal.listenerCount("data:pane-1")).toBe(0);
	});
});
