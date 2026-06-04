import { afterEach, describe, expect, test } from "bun:test";
import { createWorkspaceRuntimeRegistry } from "../registry";
import { RemoteWorkspaceRuntime } from "../remote";
import type {
	HostServiceRemoteConnection,
	RemotePtyChannel,
	RemotePtyClientMessage,
	RemotePtyControlMessage,
} from "./hostServiceRemoteTransport";
import { createWorkspaceRuntimeRegistryDeps } from "./wiring";
import {
	clearAllWorkspaceRuntimeKinds,
	setWorkspaceRemote,
} from "./workspaceRuntimeBindingStore";

const CONNECTION: HostServiceRemoteConnection = {
	origin: "http://127.0.0.1:48123",
	secret: "psk",
};

class FakeChannel implements RemotePtyChannel {
	sent: RemotePtyClientMessage[] = [];
	closed = false;
	private outputCb: ((chunk: string) => void) | null = null;
	private controlCb: ((message: RemotePtyControlMessage) => void) | null = null;
	private resolveReady!: () => void;
	readonly ready = new Promise<void>((resolve) => {
		this.resolveReady = resolve;
	});
	onOutput(cb: (chunk: string) => void): void {
		this.outputCb = cb;
	}
	onControl(cb: (message: RemotePtyControlMessage) => void): void {
		this.controlCb = cb;
	}
	send(message: RemotePtyClientMessage): void {
		this.sent.push(message);
	}
	close(): void {
		this.closed = true;
	}
	attach(): void {
		this.resolveReady();
	}
	emitOutput(chunk: string): void {
		this.outputCb?.(chunk);
	}
	emitControl(message: RemotePtyControlMessage): void {
		this.controlCb?.(message);
	}
}

afterEach(() => {
	clearAllWorkspaceRuntimeKinds();
});

describe("registry wiring -> remote runtime", () => {
	test("a remote-bound workspace routes to the RemoteWorkspaceRuntime", () => {
		setWorkspaceRemote("ws-remote", "org-1");
		const registry = createWorkspaceRuntimeRegistry(
			createWorkspaceRuntimeRegistryDeps({
				resolveConnection: () => CONNECTION,
				openChannel: () => new FakeChannel(),
			}),
		);
		expect(registry.getForWorkspaceId("ws-remote")).toBeInstanceOf(
			RemoteWorkspaceRuntime,
		);
		// An unbound workspace stays local.
		expect(registry.getForWorkspaceId("ws-local")).not.toBeInstanceOf(
			RemoteWorkspaceRuntime,
		);
	});

	test("createOrAttach streams output as a per-pane data event and never completes on exit", async () => {
		setWorkspaceRemote("ws-remote", "org-1");
		const channel = new FakeChannel();
		const registry = createWorkspaceRuntimeRegistry(
			createWorkspaceRuntimeRegistryDeps({
				resolveConnection: () => CONNECTION,
				openChannel: () => channel,
			}),
		);
		const runtime = registry.getForWorkspaceId("ws-remote");

		const data: string[] = [];
		const exits: number[] = [];
		runtime.terminal.on("data:pane-1", (chunk: string) => data.push(chunk));
		runtime.terminal.on("exit:pane-1", (code: number) => exits.push(code));

		channel.attach();
		await runtime.terminal.createOrAttach({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-remote",
			cols: 80,
			rows: 24,
		});

		channel.emitOutput("remote output");
		channel.emitControl({ type: "exit", exitCode: 0 });

		expect(data).toEqual(["remote output"]);
		// Exit is a state transition: the event fires but the event source stays
		// live (no completion), so a same-paneId restart can re-stream.
		expect(exits).toEqual([0]);
		expect(runtime.terminal.getSession("pane-1")?.isAlive).toBe(false);
	});

	test("kill terminates the remote PTY (kill frame before close)", async () => {
		setWorkspaceRemote("ws-remote", "org-1");
		const channel = new FakeChannel();
		const registry = createWorkspaceRuntimeRegistry(
			createWorkspaceRuntimeRegistryDeps({
				resolveConnection: () => CONNECTION,
				openChannel: () => channel,
			}),
		);
		const runtime = registry.getForWorkspaceId("ws-remote");

		channel.attach();
		await runtime.terminal.createOrAttach({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-remote",
			cols: 80,
			rows: 24,
		});
		await runtime.terminal.kill({ paneId: "pane-1" });

		expect(channel.sent).toContainEqual({ type: "kill" });
		expect(channel.closed).toBe(true);
		expect(runtime.terminal.getSession("pane-1")).toBeNull();
	});
});
