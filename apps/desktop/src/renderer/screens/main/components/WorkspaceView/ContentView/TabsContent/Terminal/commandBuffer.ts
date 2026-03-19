import stripAnsi from "strip-ansi";
import type { ResttyAdapter } from "./restty/ResttyAdapter";

const MAX_TITLE_LENGTH = 32;

export function sanitizeForTitle(text: string): string | null {
	const cleaned = stripAnsi(text).trim().slice(0, MAX_TITLE_LENGTH);

	return cleaned || null;
}

function getVisiblePromptBlockToCursor(adapter: ResttyAdapter): string | null {
	const state = adapter.restty.getRenderState?.();
	if (!state?.codepoints) return null;

	const { rows, cols, codepoints } = state;
	const cursor = adapter.getCursorPosition();
	const lineIndex = cursor.row;

	if (lineIndex < 0 || lineIndex >= rows) return null;

	// Walk backwards to find start of wrapped block
	let startIndex = lineIndex;
	// restty doesn't expose isWrapped yet — assume single line
	// (multi-line wrap support can be added when restty exposes wrap flags)

	let rendered = "";
	for (let index = startIndex; index <= lineIndex; index += 1) {
		const base = index * cols;
		let rowText = "";
		for (let c = 0; c < cols; c++) {
			const cp = codepoints[base + c];
			rowText += cp === 0 ? " " : String.fromCodePoint(cp);
		}
		// Trim trailing spaces (matches xterm translateToString(true))
		rowText = rowText.replace(/\s+$/, "");

		rendered +=
			index === lineIndex ? rowText.slice(0, cursor.col) : rowText;
	}

	return rendered;
}

export function isCommandEchoed(
	adapter: ResttyAdapter,
	command: string,
): boolean {
	const normalizedCommand = stripAnsi(command).trimEnd();
	if (!normalizedCommand) return false;

	const renderedPromptBlock = getVisiblePromptBlockToCursor(adapter);
	if (!renderedPromptBlock) return false;

	return renderedPromptBlock.trimEnd().endsWith(normalizedCommand);
}
