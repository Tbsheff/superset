import { describe, expect, test } from "bun:test";
import type { PtyHandle } from "@daytonaio/sdk";
import { DaytonaPtyTransport, type PtySandbox } from "./DaytonaPtyTransport.ts";

interface RecordingHandle {
	handle: PtyHandle;
	events: string[];
	inputs: Array<string | Uint8Array>;
	resizes: Array<[number, number]>;
	onData: (data: Uint8Array) => void | Promise<void>;
}

function makeSandbox(): { sandbox: PtySandbox; recorded: RecordingHandle[] } {
	const recorded: RecordingHandle[] = [];
	const build = (
		id: string,
		onData: (data: Uint8Array) => void | Promise<void>,
	): RecordingHandle => {
		const rec: RecordingHandle = {
			events: [],
			inputs: [],
			resizes: [],
			onData,
			handle: undefined as unknown as PtyHandle,
		};
		const handle = {
			sessionId: id,
			waitForConnection: async () => {
				rec.events.push("waitForConnection");
			},
			sendInput: async (data: string | Uint8Array) => {
				rec.events.push("sendInput");
				rec.inputs.push(data);
			},
			resize: async (cols: number, rows: number) => {
				rec.resizes.push([cols, rows]);
				return {} as never;
			},
			kill: async () => {
				rec.events.push("kill");
			},
			disconnect: async () => {
				rec.events.push("disconnect");
			},
			wait: async () => ({ exitCode: 0 }),
		};
		rec.handle = handle as unknown as PtyHandle;
		recorded.push(rec);
		return rec;
	};
	const sandbox: PtySandbox = {
		process: {
			createPty: async (options) => build(options.id, options.onData).handle,
			connectPty: async (sessionId, options) =>
				build(sessionId, options.onData).handle,
		},
	};
	return { sandbox, recorded };
}

describe("DaytonaPtyTransport", () => {
	test("start creates the PTY with id === paneId and waits for connection before input", async () => {
		const { sandbox, recorded } = makeSandbox();
		const transport = new DaytonaPtyTransport(sandbox, "pane-42");
		await transport.start({ cols: 80, rows: 24 });
		await transport.write("ls\n");
		const rec = recorded[0];
		expect(rec?.handle.sessionId).toBe("pane-42");
		expect(rec?.events[0]).toBe("waitForConnection");
		expect(rec?.events).toContain("sendInput");
		// waitForConnection precedes the first sendInput.
		expect(rec?.events.indexOf("waitForConnection")).toBeLessThan(
			rec?.events.indexOf("sendInput") ?? -1,
		);
	});

	test("write forwards the data verbatim — the caller owns the newline", async () => {
		const { sandbox, recorded } = makeSandbox();
		const transport = new DaytonaPtyTransport(sandbox, "p");
		await transport.start({ cols: 80, rows: 24 });
		await transport.write("echo hi\n");
		expect(recorded[0]?.inputs[0]).toBe("echo hi\n");
	});

	test("signalInterrupt sends a single 0x03 byte (Ctrl+C), not a string", async () => {
		const { sandbox, recorded } = makeSandbox();
		const transport = new DaytonaPtyTransport(sandbox, "p");
		await transport.start({ cols: 80, rows: 24 });
		await transport.signalInterrupt();
		const input = recorded[0]?.inputs[0];
		expect(input).toBeInstanceOf(Uint8Array);
		expect(Array.from(input as Uint8Array)).toEqual([3]);
	});

	test("resize forwards (cols, rows) in that order", async () => {
		const { sandbox, recorded } = makeSandbox();
		const transport = new DaytonaPtyTransport(sandbox, "p");
		await transport.start({ cols: 80, rows: 24 });
		await transport.resize(120, 40);
		expect(recorded[0]?.resizes[0]).toEqual([120, 40]);
	});

	test("kill terminates the PTY (kill, never disconnect-only)", async () => {
		const { sandbox, recorded } = makeSandbox();
		const transport = new DaytonaPtyTransport(sandbox, "p");
		await transport.start({ cols: 80, rows: 24 });
		await transport.kill();
		expect(recorded[0]?.events).toContain("kill");
		expect(recorded[0]?.events).not.toContain("disconnect");
	});

	test("a multi-byte UTF-8 glyph split across two chunks decodes to ONE string", async () => {
		const { sandbox, recorded } = makeSandbox();
		const transport = new DaytonaPtyTransport(sandbox, "p");
		let out = "";
		transport.onData((chunk) => {
			out += chunk;
		});
		await transport.start({ cols: 80, rows: 24 });
		const onData = recorded[0]?.onData;
		// 😀 == F0 9F 98 80; feed it split across two WS chunks.
		await onData?.(new Uint8Array([0xf0, 0x9f]));
		await onData?.(new Uint8Array([0x98, 0x80]));
		expect(out).toBe("😀");
	});
});
