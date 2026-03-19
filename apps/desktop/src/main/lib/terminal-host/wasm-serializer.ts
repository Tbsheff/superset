/**
 * WASM Terminal Serializer
 *
 * Generates ANSI escape sequences from restty's WASM terminal state,
 * replacing @xterm/addon-serialize.
 *
 * Reads the RenderState (typed array views into WASM memory) and
 * produces a string of ANSI sequences that, when replayed on a fresh
 * terminal, reproduces the visual state — including scrollback.
 *
 * Scrollback is accessed by scrolling the WASM viewport to the top
 * and reading pages of cells, then restoring the original scroll position.
 */

import type {
	RenderState,
	ResttyWasm,
	ResttyWasmExports,
} from "restty/internal";

// =============================================================================
// Constants
// =============================================================================

const ESC = "\x1b";
const CSI = `${ESC}[`;

// Style flag bits (from libghostty-vt)
const STYLE_BOLD = 1 << 0;
const STYLE_ITALIC = 1 << 1;
const STYLE_FAINT = 1 << 2;
const STYLE_BLINK = 1 << 3;
const STYLE_INVERSE = 1 << 4;
const STYLE_INVISIBLE = 1 << 5;
const STYLE_STRIKE = 1 << 6;
const STYLE_OVERLINE = 1 << 7;
const STYLE_UNDERLINE_MASK = 0x700; // bits 8-10

// SGR "default" marker — when fg/bg bytes are all zeros, use default color
const DEFAULT_COLOR_R = 0;
const DEFAULT_COLOR_G = 0;
const DEFAULT_COLOR_B = 0;
const DEFAULT_COLOR_A = 0;

/** Maximum serialized output size (2MB) to prevent OOM during restore */
const MAX_SERIALIZE_BYTES = 2 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

interface CellStyle {
	bold: boolean;
	italic: boolean;
	faint: boolean;
	blink: boolean;
	inverse: boolean;
	invisible: boolean;
	strike: boolean;
	overline: boolean;
	underline: number; // 0=none, 1=single, 2=double, 3=curly, 4=dotted, 5=dashed
	fgR: number;
	fgG: number;
	fgB: number;
	fgA: number;
	bgR: number;
	bgG: number;
	bgB: number;
	bgA: number;
}

const RESET_STYLE: CellStyle = {
	bold: false,
	italic: false,
	faint: false,
	blink: false,
	inverse: false,
	invisible: false,
	strike: false,
	overline: false,
	underline: 0,
	fgR: 0,
	fgG: 0,
	fgB: 0,
	fgA: 0,
	bgR: 0,
	bgG: 0,
	bgB: 0,
	bgA: 0,
};

// =============================================================================
// Serializer
// =============================================================================

/**
 * Serialize the WASM terminal state into ANSI escape sequences.
 *
 * Strategy:
 * 1. If scrollback exists, scroll viewport to top
 * 2. Read viewport pages, extracting characters and styles
 * 3. Restore original scroll position
 * 4. Generate ANSI string from collected data
 */
export function serializeWasmTerminal(
	wasm: ResttyWasm,
	handle: number,
): string {
	const exports = wasm.exports;

	// Get scrollbar info to determine if scrollback exists
	const scrollbarTotal = exports.restty_scrollbar_total;
	const scrollbarOffsetFn = exports.restty_scrollbar_offset;
	const totalRows = scrollbarTotal ? scrollbarTotal(handle) || 0 : 0;
	const scrollbarOffset = scrollbarOffsetFn
		? scrollbarOffsetFn(handle) || 0
		: 0;

	// Read initial render state to get viewport dimensions
	wasm.renderUpdate(handle);
	const initialState = wasm.getRenderState(handle);
	if (!initialState?.codepoints) {
		return "";
	}

	const viewportRows = initialState.rows;
	const cols = initialState.cols;

	let result: string;

	// If no scrollback or scrollbar not supported, just serialize current viewport
	if (!scrollbarTotal || totalRows <= viewportRows) {
		result = serializeRenderState(initialState, cols);
	} else {
		// Serialize with scrollback: scroll to top, read pages, restore
		result = serializeWithScrollback(
			wasm,
			handle,
			exports,
			viewportRows,
			cols,
			totalRows,
			scrollbarOffset,
		);
	}

	// Cap output size to prevent OOM during restore
	if (result.length > MAX_SERIALIZE_BYTES) {
		result = result.slice(-MAX_SERIALIZE_BYTES);
	}

	return result;
}

function serializeWithScrollback(
	wasm: ResttyWasm,
	handle: number,
	exports: ResttyWasmExports,
	viewportRows: number,
	cols: number,
	totalRows: number,
	originalOffset: number,
): string {
	// Scroll to the very top (oldest scrollback)
	if (exports.restty_scroll_viewport) {
		exports.restty_scroll_viewport(handle, -(totalRows + viewportRows));
	}

	const allRowData: string[][] = [];
	const allRowStyles: CellStyle[][] = [];
	let rowsCollected = 0;
	const targetRows = totalRows;

	// Read viewport-sized pages until we've collected all rows
	while (rowsCollected < targetRows) {
		wasm.renderUpdate(handle);
		const state = wasm.getRenderState(handle);
		if (!state?.codepoints) break;

		const rowsToRead = Math.min(state.rows, targetRows - rowsCollected);
		for (let r = 0; r < rowsToRead; r++) {
			const { chars, styles } = extractRow(state, r, cols);
			allRowData.push(chars);
			allRowStyles.push(styles);
		}

		rowsCollected += rowsToRead;

		// Advance viewport
		if (rowsCollected < targetRows && exports.restty_scroll_viewport) {
			exports.restty_scroll_viewport(handle, viewportRows);
		}
	}

	// Restore original scroll position
	if (exports.restty_scroll_viewport) {
		// Scroll back to original position
		// After reading, we're near the bottom. Restore exact offset.
		exports.restty_scroll_viewport(handle, totalRows + viewportRows);
		if (originalOffset > 0 && exports.restty_scrollbar_offset) {
			const currentOffset = exports.restty_scrollbar_offset(handle) || 0;
			const delta = originalOffset - currentOffset;
			if (delta !== 0) {
				exports.restty_scroll_viewport(handle, -delta);
			}
		}
	}
	wasm.renderUpdate(handle);

	// Build ANSI string from collected data
	return buildAnsiFromRows(allRowData, allRowStyles, cols);
}

// =============================================================================
// Row Extraction
// =============================================================================

function extractRow(
	state: RenderState,
	row: number,
	cols: number,
): { chars: string[]; styles: CellStyle[] } {
	const base = row * cols;
	const chars: string[] = [];
	const styles: CellStyle[] = [];

	for (let col = 0; col < cols; col++) {
		const idx = base + col;

		// Extract character
		let ch = "";
		if (
			state.graphemeOffset &&
			state.graphemeLen &&
			state.graphemeBuffer &&
			(state.graphemeLen[idx] ?? 0) > 0
		) {
			// Multi-codepoint grapheme cluster
			const offset = state.graphemeOffset[idx] ?? 0;
			const len = state.graphemeLen[idx] ?? 0;
			for (let g = 0; g < len; g++) {
				ch += String.fromCodePoint(state.graphemeBuffer[offset + g] ?? 0);
			}
		} else {
			const cp = state.codepoints?.[idx] ?? 0;
			if (cp === 0) {
				ch = ""; // Empty/padding cell
			} else {
				ch = String.fromCodePoint(cp);
			}
		}

		// Extract style
		const style: CellStyle = { ...RESET_STYLE };

		if (state.styleFlags) {
			const flags = state.styleFlags[idx] ?? 0;
			style.bold = (flags & STYLE_BOLD) !== 0;
			style.italic = (flags & STYLE_ITALIC) !== 0;
			style.faint = (flags & STYLE_FAINT) !== 0;
			style.blink = (flags & STYLE_BLINK) !== 0;
			style.inverse = (flags & STYLE_INVERSE) !== 0;
			style.invisible = (flags & STYLE_INVISIBLE) !== 0;
			style.strike = (flags & STYLE_STRIKE) !== 0;
			style.overline = (flags & STYLE_OVERLINE) !== 0;
			style.underline = (flags & STYLE_UNDERLINE_MASK) >> 8;
		}

		if (state.fgBytes) {
			const fi = idx * 4;
			style.fgR = state.fgBytes[fi] ?? 0;
			style.fgG = state.fgBytes[fi + 1] ?? 0;
			style.fgB = state.fgBytes[fi + 2] ?? 0;
			style.fgA = state.fgBytes[fi + 3] ?? 0;
		}

		if (state.bgBytes) {
			const bi = idx * 4;
			style.bgR = state.bgBytes[bi] ?? 0;
			style.bgG = state.bgBytes[bi + 1] ?? 0;
			style.bgB = state.bgBytes[bi + 2] ?? 0;
			style.bgA = state.bgBytes[bi + 3] ?? 0;
		}

		chars.push(ch);
		styles.push(style);
	}

	return { chars, styles };
}

// =============================================================================
// ANSI Generation
// =============================================================================

function serializeRenderState(state: RenderState, cols: number): string {
	const allChars: string[][] = [];
	const allStyles: CellStyle[][] = [];

	for (let r = 0; r < state.rows; r++) {
		const { chars, styles } = extractRow(state, r, cols);
		allChars.push(chars);
		allStyles.push(styles);
	}

	const ansi = buildAnsiFromRows(allChars, allStyles, cols);

	// Add cursor position if available
	if (state.cursor) {
		return `${ansi}${CSI}${state.cursor.row + 1};${state.cursor.col + 1}H`;
	}

	return ansi;
}

function buildAnsiFromRows(
	allChars: string[][],
	allStyles: CellStyle[][],
	cols: number,
): string {
	const parts: string[] = [];
	let currentStyle: CellStyle = { ...RESET_STYLE };
	let needsReset = false;

	// Start with reset
	parts.push(`${CSI}0m`);

	for (let row = 0; row < allChars.length; row++) {
		const chars = allChars[row];
		const styles = allStyles[row];
		if (!chars || !styles) continue;

		// Find last non-empty character for trimming trailing whitespace
		let lastNonEmpty = -1;
		for (let col = cols - 1; col >= 0; col--) {
			const ch = chars[col] ?? "";
			if (ch !== "" && ch !== " ") {
				lastNonEmpty = col;
				break;
			}
			// Also check if the cell has non-default background
			const style = styles[col];
			if (style && !isDefaultBg(style)) {
				lastNonEmpty = col;
				break;
			}
		}

		for (let col = 0; col <= lastNonEmpty; col++) {
			const ch = chars[col] ?? "";
			const style = styles[col] ?? RESET_STYLE;

			// Emit SGR changes
			const sgr = buildSgrDelta(currentStyle, style);
			if (sgr) {
				parts.push(sgr);
				needsReset = true;
			}
			currentStyle = style;

			// Emit character (empty cells become spaces)
			parts.push(ch || " ");
		}

		// Add line break for all rows except the last
		if (row < allChars.length - 1) {
			// Reset SGR before line break to avoid bg color bleeding
			if (needsReset) {
				parts.push(`${CSI}0m`);
				currentStyle = { ...RESET_STYLE };
				needsReset = false;
			}
			parts.push("\r\n");
		}
	}

	// Final reset
	if (needsReset) {
		parts.push(`${CSI}0m`);
	}

	return parts.join("");
}

function buildSgrDelta(prev: CellStyle, next: CellStyle): string | null {
	if (stylesEqual(prev, next)) return null;

	const params: number[] = [];

	// Check if we need a full reset (any attribute turned off)
	const needsReset =
		(prev.bold && !next.bold) ||
		(prev.italic && !next.italic) ||
		(prev.faint && !next.faint) ||
		(prev.blink && !next.blink) ||
		(prev.inverse && !next.inverse) ||
		(prev.invisible && !next.invisible) ||
		(prev.strike && !next.strike) ||
		(prev.overline && !next.overline) ||
		(prev.underline > 0 && next.underline === 0);

	if (needsReset) {
		// Reset and re-apply all active attributes
		params.push(0);

		if (next.bold) params.push(1);
		if (next.faint) params.push(2);
		if (next.italic) params.push(3);
		if (next.underline > 0) {
			params.push(next.underline === 1 ? 4 : 4);
			// Extended underline style via SGR 4:style
			// For simplicity, just use SGR 4 for any underline
		}
		if (next.blink) params.push(5);
		if (next.inverse) params.push(7);
		if (next.invisible) params.push(8);
		if (next.strike) params.push(9);
		if (next.overline) params.push(53);

		// Re-apply colors after reset
		if (!isDefaultFg(next)) {
			params.push(38, 2, next.fgR, next.fgG, next.fgB);
		}
		if (!isDefaultBg(next)) {
			params.push(48, 2, next.bgR, next.bgG, next.bgB);
		}
	} else {
		// Incremental: only add newly enabled attributes
		if (!prev.bold && next.bold) params.push(1);
		if (!prev.faint && next.faint) params.push(2);
		if (!prev.italic && next.italic) params.push(3);
		if (prev.underline !== next.underline && next.underline > 0) {
			params.push(4);
		}
		if (!prev.blink && next.blink) params.push(5);
		if (!prev.inverse && next.inverse) params.push(7);
		if (!prev.invisible && next.invisible) params.push(8);
		if (!prev.strike && next.strike) params.push(9);
		if (!prev.overline && next.overline) params.push(53);

		// Color changes
		if (
			prev.fgR !== next.fgR ||
			prev.fgG !== next.fgG ||
			prev.fgB !== next.fgB ||
			prev.fgA !== next.fgA
		) {
			if (isDefaultFg(next)) {
				params.push(39); // Default foreground
			} else {
				params.push(38, 2, next.fgR, next.fgG, next.fgB);
			}
		}

		if (
			prev.bgR !== next.bgR ||
			prev.bgG !== next.bgG ||
			prev.bgB !== next.bgB ||
			prev.bgA !== next.bgA
		) {
			if (isDefaultBg(next)) {
				params.push(49); // Default background
			} else {
				params.push(48, 2, next.bgR, next.bgG, next.bgB);
			}
		}
	}

	if (params.length === 0) return null;
	return `${CSI}${params.join(";")}m`;
}

// =============================================================================
// Helpers
// =============================================================================

function isDefaultFg(style: CellStyle): boolean {
	return (
		style.fgR === DEFAULT_COLOR_R &&
		style.fgG === DEFAULT_COLOR_G &&
		style.fgB === DEFAULT_COLOR_B &&
		style.fgA === DEFAULT_COLOR_A
	);
}

function isDefaultBg(style: CellStyle): boolean {
	return (
		style.bgR === DEFAULT_COLOR_R &&
		style.bgG === DEFAULT_COLOR_G &&
		style.bgB === DEFAULT_COLOR_B &&
		style.bgA === DEFAULT_COLOR_A
	);
}

function stylesEqual(a: CellStyle, b: CellStyle): boolean {
	return (
		a.bold === b.bold &&
		a.italic === b.italic &&
		a.faint === b.faint &&
		a.blink === b.blink &&
		a.inverse === b.inverse &&
		a.invisible === b.invisible &&
		a.strike === b.strike &&
		a.overline === b.overline &&
		a.underline === b.underline &&
		a.fgR === b.fgR &&
		a.fgG === b.fgG &&
		a.fgB === b.fgB &&
		a.fgA === b.fgA &&
		a.bgR === b.bgR &&
		a.bgG === b.bgG &&
		a.bgB === b.bgB &&
		a.bgA === b.bgA
	);
}
