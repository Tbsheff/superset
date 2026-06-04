/**
 * Phase B hard-gate (renderer side): a streaming-command runtime drives the real
 * terminal in read-only/log mode. The load-bearing behavior is that input is
 * gated by isReadOnlyRef while stream data still reaches xterm.
 *
 * Desktop has no RTL/happy-dom test runner (see bunfig.toml), so this mirrors the
 * standalone-model pattern already used by useTerminalLifecycle.test.ts: it
 * reproduces the exact input-gate guard from useTerminalLifecycle.ts
 * (handleTerminalInput / handleKeyPress) and the data path from
 * useTerminalStream.ts (only {type:"data"} calls xterm.write), then asserts the
 * read-only behavior across both.
 */
import { describe, expect, it } from "bun:test";

type StreamEvent =
	| { type: "data"; data: string }
	| { type: "exit"; exitCode: number };

// Mirrors the guard added at the top of handleTerminalInput / handleKeyPress.
function makeInputGate(refs: {
	isReadOnlyRef: { current: boolean };
	isRestoredModeRef: { current: boolean };
	connectionErrorRef: { current: string | null };
}) {
	let writes = 0;
	const handleTerminalInput = (_data: string) => {
		if (refs.isReadOnlyRef.current) return;
		if (refs.isRestoredModeRef.current || refs.connectionErrorRef.current)
			return;
		writes++;
	};
	return { handleTerminalInput, getWrites: () => writes };
}

// Mirrors useTerminalStream.handleStreamData: only "data" calls xterm.write.
function makeStreamSink(xterm: { write: (s: string) => void }) {
	return (event: StreamEvent) => {
		if (event.type === "data") xterm.write(event.data);
	};
}

describe("terminal read-only mode — Phase B renderer gate", () => {
	it("drops user keystrokes when read-only", () => {
		const refs = {
			isReadOnlyRef: { current: true },
			isRestoredModeRef: { current: false },
			connectionErrorRef: { current: null as string | null },
		};
		const { handleTerminalInput, getWrites } = makeInputGate(refs);
		handleTerminalInput("x");
		handleTerminalInput("ls\n");
		expect(getWrites()).toBe(0);
	});

	it("forwards user keystrokes when NOT read-only", () => {
		const refs = {
			isReadOnlyRef: { current: false },
			isRestoredModeRef: { current: false },
			connectionErrorRef: { current: null as string | null },
		};
		const { handleTerminalInput, getWrites } = makeInputGate(refs);
		handleTerminalInput("x");
		expect(getWrites()).toBe(1);
	});

	it("streams runtime data to xterm even in read-only mode", () => {
		let written = "";
		const xterm = {
			write: (s: string) => {
				written += s;
			},
		};
		const sink = makeStreamSink(xterm);
		sink({ type: "data", data: "fake-command-workspace: ready\n" });
		sink({ type: "data", data: "wrote contract-fs.txt\n" });
		sink({ type: "exit", exitCode: 0 });
		expect(written).toContain("fake-command-workspace: ready");
		expect(written).toContain("wrote contract-fs.txt");
	});

	it("read-only drops input AND passes stream data — the full gate", () => {
		const refs = {
			isReadOnlyRef: { current: true },
			isRestoredModeRef: { current: false },
			connectionErrorRef: { current: null as string | null },
		};
		const { handleTerminalInput, getWrites } = makeInputGate(refs);
		let written = "";
		const sink = makeStreamSink({
			write: (s: string) => {
				written += s;
			},
		});

		handleTerminalInput("interactive input");
		sink({ type: "data", data: "log output\n" });

		expect(getWrites()).toBe(0);
		expect(written).toBe("log output\n");
	});
});
