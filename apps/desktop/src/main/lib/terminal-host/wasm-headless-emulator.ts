/**
 * WASM Headless Terminal Emulator
 *
 * Drop-in replacement for HeadlessEmulator that uses restty's libghostty-vt
 * WASM module instead of @xterm/headless + @xterm/addon-serialize.
 *
 * Benefits:
 * - VT parsing in Zig→WASM (faster than xterm's JavaScript parser)
 * - Cell data stored in WASM linear memory (~6MB vs ~16MB JS objects)
 * - Eliminates need for @xterm/headless polyfill in Bun
 * - Single WASM module shared across all sessions
 *
 * The mode tracking (DECSET/DECRST) and CWD extraction (OSC-7) logic is
 * identical to HeadlessEmulator — it's pure regex parsing on the input
 * data stream, independent of the VT emulator backend.
 */

import type { ResttyWasm } from "restty/internal";
import {
	DEFAULT_MODES,
	type TerminalModes,
	type TerminalSnapshot,
} from "./types";
import { serializeWasmTerminal } from "./wasm-serializer";
import { getWasmVt } from "./wasm-vt";

// =============================================================================
// Mode Tracking Constants (shared with HeadlessEmulator)
// =============================================================================

const ESC = "\x1b";
const BEL = "\x07";

const MODE_MAP: Record<number, keyof TerminalModes> = {
	1: "applicationCursorKeys",
	6: "originMode",
	7: "autoWrap",
	9: "mouseTrackingX10",
	25: "cursorVisible",
	47: "alternateScreen",
	1000: "mouseTrackingNormal",
	1001: "mouseTrackingHighlight",
	1002: "mouseTrackingButtonEvent",
	1003: "mouseTrackingAnyEvent",
	1004: "focusReporting",
	1005: "mouseUtf8",
	1006: "mouseSgr",
	1049: "alternateScreen",
	2004: "bracketedPaste",
};

// =============================================================================
// Emulator Class
// =============================================================================

export interface WasmHeadlessEmulatorOptions {
	cols?: number;
	rows?: number;
	scrollback?: number;
}

export class WasmHeadlessEmulator {
	private wasm: ResttyWasm;
	private handle: number;
	private _cols: number;
	private _rows: number;
	private modes: TerminalModes;
	private cwd: string | null = null;
	private disposed = false;

	// Pending output for query responses
	private onDataCallback?: (data: string) => void;

	// Escape sequence buffer for chunk-safe parsing
	private escapeSequenceBuffer = "";
	private static readonly MAX_ESCAPE_BUFFER_SIZE = 1024;

	constructor(options: WasmHeadlessEmulatorOptions = {}) {
		const { cols = 80, rows = 24, scrollback = 10000 } = options;

		this._cols = cols;
		this._rows = rows;
		this.modes = { ...DEFAULT_MODES };

		// Get the pre-loaded WASM instance
		this.wasm = getWasmVt();
		// maxScrollback in restty is in bytes, approximate: rows * cols * ~200 bytes/cell
		this.handle = this.wasm.create(cols, rows, scrollback * 200);
	}

	/**
	 * Set callback for terminal-generated output (query responses)
	 */
	onData(callback: (data: string) => void): void {
		this.onDataCallback = callback;
	}

	/**
	 * Get and clear pending output (query responses)
	 */
	flushPendingOutput(): string[] {
		if (this.disposed) return [];
		const output = this.wasm.drainOutput(this.handle);
		if (output) return [output];
		return [];
	}

	/**
	 * Write data to the terminal emulator.
	 * WASM write is synchronous — data is processed immediately.
	 */
	write(data: string): void {
		if (this.disposed) return;

		// Parse escape sequences for mode/CWD tracking
		this.parseEscapeSequences(data);

		// Write to WASM VT parser (synchronous)
		this.wasm.write(this.handle, data);

		// Drain query responses
		this.drainAndNotify();
	}

	/**
	 * Write data and wait for completion.
	 * Since WASM writes are synchronous, this resolves immediately.
	 */
	async writeSync(data: string): Promise<void> {
		this.write(data);
	}

	/**
	 * Resize the terminal
	 */
	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		this._cols = cols;
		this._rows = rows;
		this.wasm.resize(this.handle, cols, rows);
	}

	/**
	 * Get current terminal dimensions
	 */
	getDimensions(): { cols: number; rows: number } {
		return { cols: this._cols, rows: this._rows };
	}

	/**
	 * Get current terminal modes
	 */
	getModes(): TerminalModes {
		return { ...this.modes };
	}

	/**
	 * Get current working directory (from OSC-7)
	 */
	getCwd(): string | null {
		return this.cwd;
	}

	/**
	 * Set CWD directly (for initial session setup)
	 */
	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	/**
	 * Get scrollback line count
	 */
	getScrollbackLines(): number {
		if (this.disposed) return 0;
		const exports = this.wasm.exports;
		if (exports.restty_scrollbar_total) {
			return exports.restty_scrollbar_total(this.handle) || 0;
		}
		return this._rows;
	}

	/**
	 * Flush all pending writes.
	 * No-op for WASM since writes are synchronous.
	 */
	async flush(): Promise<void> {
		// WASM writes are synchronous — nothing to flush
	}

	/**
	 * Generate a complete snapshot for session restore.
	 */
	getSnapshot(): TerminalSnapshot {
		const snapshotAnsi = serializeWasmTerminal(this.wasm, this.handle);
		const rehydrateSequences = this.generateRehydrateSequences();

		return {
			snapshotAnsi,
			rehydrateSequences,
			cwd: this.cwd,
			modes: { ...this.modes },
			cols: this._cols,
			rows: this._rows,
			scrollbackLines: this.getScrollbackLines(),
			debug: {
				xtermBufferType: this.modes.alternateScreen ? "alternate" : "normal",
				hasAltScreenEntry: snapshotAnsi.includes("\x1b[?1049h"),
				normalBufferLines: this.getScrollbackLines(),
			},
		};
	}

	/**
	 * Generate a complete snapshot after flushing pending writes.
	 */
	async getSnapshotAsync(): Promise<TerminalSnapshot> {
		await this.flush();
		return this.getSnapshot();
	}

	/**
	 * Clear terminal buffer
	 */
	clear(): void {
		if (this.disposed) return;
		// Write clear screen + reset scrollback via escape sequences
		this.wasm.write(this.handle, "\x1b[2J\x1b[3J\x1b[H");
	}

	/**
	 * Reset terminal to default state
	 */
	reset(): void {
		if (this.disposed) return;
		// Send RIS (Reset to Initial State)
		this.wasm.write(this.handle, "\x1bc");
		this.modes = { ...DEFAULT_MODES };
	}

	/**
	 * Dispose of the terminal
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.wasm.destroy(this.handle);
	}

	// ===========================================================================
	// Private Methods
	// ===========================================================================

	/**
	 * Drain output from WASM and notify callback
	 */
	private drainAndNotify(): void {
		const output = this.wasm.drainOutput(this.handle);
		if (output && this.onDataCallback) {
			this.onDataCallback(output);
		}
	}

	/**
	 * Parse escape sequences with chunk-safe buffering.
	 * Identical logic to HeadlessEmulator — pure regex, no xterm dependency.
	 */
	private parseEscapeSequences(data: string): void {
		const fullData = this.escapeSequenceBuffer + data;
		this.escapeSequenceBuffer = "";

		this.parseModeChanges(fullData);
		this.parseOsc7(fullData);

		const incompleteSequence = this.findIncompleteTrackedSequence(fullData);
		if (incompleteSequence) {
			if (
				incompleteSequence.length <= WasmHeadlessEmulator.MAX_ESCAPE_BUFFER_SIZE
			) {
				this.escapeSequenceBuffer = incompleteSequence;
			}
		}
	}

	private parseModeChanges(data: string): void {
		const modeRegex = new RegExp(
			`${escapeRegex(ESC)}\\[\\?([0-9;]+)([hl])`,
			"g",
		);

		for (const match of data.matchAll(modeRegex)) {
			const modesStr = match[1];
			const action = match[2];
			const enable = action === "h";

			const modeNumbers = modesStr
				.split(";")
				.map((s) => Number.parseInt(s, 10));

			for (const modeNum of modeNumbers) {
				const modeName = MODE_MAP[modeNum];
				if (modeName) {
					this.modes[modeName] = enable;
				}
			}
		}
	}

	private parseOsc7(data: string): void {
		const escEscaped = escapeRegex(ESC);
		const belEscaped = escapeRegex(BEL);

		const osc7Pattern = `${escEscaped}\\]7;file://[^/]*(/.+?)(?:${belEscaped}|${escEscaped}\\\\)`;
		const osc7Regex = new RegExp(osc7Pattern, "g");

		for (const match of data.matchAll(osc7Regex)) {
			if (match[1]) {
				try {
					this.cwd = decodeURIComponent(match[1]);
				} catch {
					this.cwd = match[1];
				}
			}
		}
	}

	private findIncompleteTrackedSequence(data: string): string | null {
		const escEscaped = escapeRegex(ESC);
		const lastEscIndex = data.lastIndexOf(ESC);
		if (lastEscIndex === -1) return null;

		const afterLastEsc = data.slice(lastEscIndex);

		// DECSET/DECRST pattern
		if (afterLastEsc.startsWith(`${ESC}[?`)) {
			const completePattern = new RegExp(`${escEscaped}\\[\\?[0-9;]+[hl]`);
			if (completePattern.test(afterLastEsc)) {
				const globalPattern = new RegExp(`${escEscaped}\\[\\?[0-9;]+[hl]`, "g");
				const matches = afterLastEsc.match(globalPattern);
				if (matches && matches.length > 0) {
					const lastMatch = matches[matches.length - 1] as string;
					const lastMatchEnd =
						afterLastEsc.lastIndexOf(lastMatch) + lastMatch.length;
					const remainder = afterLastEsc.slice(lastMatchEnd);
					if (remainder.includes(ESC)) {
						return this.findIncompleteTrackedSequence(remainder);
					}
				}
				return null;
			}
			return afterLastEsc;
		}

		// OSC-7 pattern
		if (afterLastEsc.startsWith(`${ESC}]7;`)) {
			if (afterLastEsc.includes(BEL) || afterLastEsc.includes(`${ESC}\\`)) {
				return null;
			}
			return afterLastEsc;
		}

		// Partial starts
		if (afterLastEsc === ESC) return afterLastEsc;
		if (afterLastEsc === `${ESC}[`) return afterLastEsc;
		if (afterLastEsc === `${ESC}]`) return afterLastEsc;
		if (afterLastEsc === `${ESC}]7`) return afterLastEsc;
		const incompleteDecset = new RegExp(`^${escEscaped}\\[\\?[0-9;]*$`);
		if (incompleteDecset.test(afterLastEsc)) return afterLastEsc;

		return null;
	}

	private generateRehydrateSequences(): string {
		const sequences: string[] = [];

		const addModeSequence = (
			modeNum: number,
			enabled: boolean,
			defaultEnabled: boolean,
		) => {
			if (enabled !== defaultEnabled) {
				sequences.push(`${ESC}[?${modeNum}${enabled ? "h" : "l"}`);
			}
		};

		addModeSequence(1, this.modes.applicationCursorKeys, false);
		addModeSequence(6, this.modes.originMode, false);
		addModeSequence(7, this.modes.autoWrap, true);
		addModeSequence(25, this.modes.cursorVisible, true);
		addModeSequence(9, this.modes.mouseTrackingX10, false);
		addModeSequence(1000, this.modes.mouseTrackingNormal, false);
		addModeSequence(1001, this.modes.mouseTrackingHighlight, false);
		addModeSequence(1002, this.modes.mouseTrackingButtonEvent, false);
		addModeSequence(1003, this.modes.mouseTrackingAnyEvent, false);
		addModeSequence(1005, this.modes.mouseUtf8, false);
		addModeSequence(1006, this.modes.mouseSgr, false);
		addModeSequence(1004, this.modes.focusReporting, false);
		addModeSequence(2004, this.modes.bracketedPaste, false);

		return sequences.join("");
	}
}

// =============================================================================
// Utility
// =============================================================================

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply a snapshot to a WASM headless emulator (for testing round-trip)
 */
export function applySnapshot(
	emulator: WasmHeadlessEmulator,
	snapshot: TerminalSnapshot,
): void {
	emulator.write(snapshot.rehydrateSequences);
	emulator.write(snapshot.snapshotAnsi);
}

/**
 * Compare two mode states for equality
 */
export function modesEqual(a: TerminalModes, b: TerminalModes): boolean {
	return (
		a.applicationCursorKeys === b.applicationCursorKeys &&
		a.bracketedPaste === b.bracketedPaste &&
		a.mouseTrackingX10 === b.mouseTrackingX10 &&
		a.mouseTrackingNormal === b.mouseTrackingNormal &&
		a.mouseTrackingHighlight === b.mouseTrackingHighlight &&
		a.mouseTrackingButtonEvent === b.mouseTrackingButtonEvent &&
		a.mouseTrackingAnyEvent === b.mouseTrackingAnyEvent &&
		a.focusReporting === b.focusReporting &&
		a.mouseUtf8 === b.mouseUtf8 &&
		a.mouseSgr === b.mouseSgr &&
		a.alternateScreen === b.alternateScreen &&
		a.cursorVisible === b.cursorVisible &&
		a.originMode === b.originMode &&
		a.autoWrap === b.autoWrap
	);
}
