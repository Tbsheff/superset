import { describe, expect, it } from "bun:test";
import type { ResttyAdapter } from "./restty/ResttyAdapter";
import { isCommandEchoed, sanitizeForTitle } from "./commandBuffer";

/**
 * Build a minimal ResttyAdapter mock from an array of text rows.
 *
 * Each row is padded to `cols` characters so codepoints indexing works
 * correctly. cursorX defaults to the end of the last line; cursorY defaults
 * to the last row index.
 */
function makeAdapter(
	lines: Array<{ text: string }>,
	options: {
		cursorX?: number;
		cursorY?: number;
	} = {},
): ResttyAdapter {
	const cols = Math.max(...lines.map((l) => l.text.length), 1);
	const rows = lines.length;
	const cursorY = options.cursorY ?? Math.max(rows - 1, 0);
	const cursorX = options.cursorX ?? (lines.at(-1)?.text.length ?? 0);

	// Build flat codepoints array (rows × cols)
	const codepoints = new Uint32Array(rows * cols);
	for (let r = 0; r < rows; r++) {
		const text = lines[r]?.text ?? "";
		for (let c = 0; c < text.length && c < cols; c++) {
			codepoints[r * cols + c] = text.codePointAt(c) ?? 0;
		}
		// Remaining cells stay 0 (empty/space)
	}

	const renderState = { rows, cols, codepoints, graphemeOffset: null, graphemeLen: null, graphemeBuffer: null };

	return {
		getCursorPosition: () => ({ col: cursorX, row: cursorY }),
		restty: {
			getRenderState: () => renderState,
		},
	} as unknown as ResttyAdapter;
}

describe("sanitizeForTitle", () => {
	it("should keep normal text unchanged", () => {
		expect(sanitizeForTitle("ls -la ./src")).toBe("ls -la ./src");
	});

	it("should keep uppercase letters", () => {
		expect(sanitizeForTitle("openCode")).toBe("openCode");
	});

	it("should keep special characters", () => {
		expect(sanitizeForTitle("npm install @scope/pkg")).toBe(
			"npm install @scope/pkg",
		);
	});

	it("should strip ANSI escape sequences", () => {
		expect(sanitizeForTitle("\x1b[32mgreen\x1b[0m")).toBe("green");
		expect(sanitizeForTitle("\x1b[1;34mbold blue\x1b[0m")).toBe("bold blue");
	});

	it("should truncate to max length", () => {
		const longCommand = "a".repeat(100);
		const result = sanitizeForTitle(longCommand);
		expect(result?.length).toBe(32);
	});

	it("should return null for empty result", () => {
		expect(sanitizeForTitle("")).toBeNull();
	});

	it("should return null for whitespace-only result", () => {
		expect(sanitizeForTitle("   ")).toBeNull();
	});

	it("should trim whitespace", () => {
		expect(sanitizeForTitle("  command  ")).toBe("command");
	});
});

describe("isCommandEchoed", () => {
	it("returns true when the rendered prompt line ends with the typed command", () => {
		const adapter = makeAdapter([{ text: "$ ls -la" }]);

		expect(isCommandEchoed(adapter, "ls -la")).toBe(true);
	});

	it("returns false when masked input is not echoed on screen", () => {
		const adapter = makeAdapter([{ text: "[sudo] password for alice: " }]);

		expect(isCommandEchoed(adapter, "hunter2")).toBe(false);
	});

	it("returns false when the prompt contains the same substring as the secret", () => {
		const adapter = makeAdapter([{ text: "[sudo] password for alice: " }]);

		expect(isCommandEchoed(adapter, "alice")).toBe(false);
	});

	it("uses the cursor position on the current line", () => {
		const adapter = makeAdapter([{ text: "$ npm test ghost-text" }], {
			cursorX: "$ npm test".length,
		});

		expect(isCommandEchoed(adapter, "npm test")).toBe(true);
		expect(isCommandEchoed(adapter, "npm test ghost-text")).toBe(false);
	});

	it("returns false for empty commands", () => {
		const adapter = makeAdapter([{ text: "$ " }]);

		expect(isCommandEchoed(adapter, "")).toBe(false);
		expect(isCommandEchoed(adapter, "   ")).toBe(false);
	});
});
