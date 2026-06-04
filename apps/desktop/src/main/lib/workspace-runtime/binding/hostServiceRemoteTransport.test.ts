import { describe, expect, test } from "bun:test";
import {
	createHostServiceRemoteTransportFactory,
	type HostServiceRemoteConnection,
	type RemotePtyChannel,
	type RemotePtyClientMessage,
	type RemotePtyControlMessage,
} from "./hostServiceRemoteTransport";

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

	// Test helpers.
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

function makeFactoryWithChannel(channel: FakeChannel) {
	const opened: Array<{ workspaceId: string; paneId: string }> = [];
	const factory = createHostServiceRemoteTransportFactory({
		resolveConnection: () => CONNECTION,
		openChannel: ({ workspaceId, paneId }) => {
			opened.push({ workspaceId, paneId });
			return channel;
		},
	});
	return { factory, opened };
}

describe("host-service remote PTY transport", () => {
	test("start forwards the renderer dimensions after the host attaches", async () => {
		const channel = new FakeChannel();
		const { factory, opened } = makeFactoryWithChannel(channel);
		const transport = factory({ workspaceId: "ws", paneId: "p1" });

		channel.attach();
		await transport.start({ cols: 120, rows: 40 });

		expect(opened).toEqual([{ workspaceId: "ws", paneId: "p1" }]);
		expect(channel.sent).toEqual([{ type: "resize", cols: 120, rows: 40 }]);
	});

	test("forwards decoded output strings verbatim", async () => {
		const channel = new FakeChannel();
		const { factory } = makeFactoryWithChannel(channel);
		const transport = factory({ workspaceId: "ws", paneId: "p1" });
		const chunks: string[] = [];
		transport.onData((chunk) => chunks.push(chunk));

		channel.attach();
		await transport.start({ cols: 80, rows: 24 });
		channel.emitOutput("hello ");
		channel.emitOutput("world");

		expect(chunks).toEqual(["hello ", "world"]);
	});

	test("write sends an input frame; interrupt sends a raw Ctrl+C byte", async () => {
		const channel = new FakeChannel();
		const { factory } = makeFactoryWithChannel(channel);
		const transport = factory({ workspaceId: "ws", paneId: "p1" });

		channel.attach();
		await transport.start({ cols: 80, rows: 24 });
		await transport.write("ls\n");
		await transport.signalInterrupt();
		await transport.resize(100, 30);

		expect(channel.sent).toEqual([
			{ type: "resize", cols: 80, rows: 24 },
			{ type: "input", data: "ls\n" },
			{ type: "input", data: "" },
			{ type: "resize", cols: 100, rows: 30 },
		]);
	});

	test("onExit fires once and never repeats (exit is a state transition)", async () => {
		const channel = new FakeChannel();
		const { factory } = makeFactoryWithChannel(channel);
		const transport = factory({ workspaceId: "ws", paneId: "p1" });
		const exits: Array<{ exitCode: number; error?: string }> = [];
		transport.onExit((info) => exits.push(info));

		channel.attach();
		await transport.start({ cols: 80, rows: 24 });
		channel.emitControl({ type: "exit", exitCode: 0 });
		// A late duplicate exit (or error) frame must not re-fire.
		channel.emitControl({ type: "exit", exitCode: 0 });
		channel.emitControl({ type: "error", message: "ignored after exit" });

		expect(exits).toEqual([{ exitCode: 0 }]);
	});

	test("an error control frame surfaces as a single exit with the message", async () => {
		const channel = new FakeChannel();
		const { factory } = makeFactoryWithChannel(channel);
		const transport = factory({ workspaceId: "ws", paneId: "p1" });
		const exits: Array<{ exitCode: number; error?: string }> = [];
		transport.onExit((info) => exits.push(info));

		channel.attach();
		await transport.start({ cols: 80, rows: 24 });
		channel.emitControl({ type: "error", message: "sandbox vanished" });

		expect(exits).toEqual([{ exitCode: 1, error: "sandbox vanished" }]);
	});

	test("kill sends a kill frame BEFORE closing so the host terminates the PTY", async () => {
		const channel = new FakeChannel();
		const { factory } = makeFactoryWithChannel(channel);
		const transport = factory({ workspaceId: "ws", paneId: "p1" });

		channel.attach();
		await transport.start({ cols: 80, rows: 24 });
		await transport.kill();

		expect(channel.sent.at(-1)).toEqual({ type: "kill" });
		expect(channel.closed).toBe(true);
	});

	test("start throws when no host-service connection is available", async () => {
		const factory = createHostServiceRemoteTransportFactory({
			resolveConnection: () => null,
			openChannel: () => new FakeChannel(),
		});
		const transport = factory({ workspaceId: "ws", paneId: "p1" });

		await expect(transport.start({ cols: 80, rows: 24 })).rejects.toThrow(
			/no running host-service connection/,
		);
	});

	test("resolving a transport opens no channel until start()", () => {
		const channel = new FakeChannel();
		const { factory, opened } = makeFactoryWithChannel(channel);
		factory({ workspaceId: "ws", paneId: "p1" });
		expect(opened).toEqual([]);
	});
});
