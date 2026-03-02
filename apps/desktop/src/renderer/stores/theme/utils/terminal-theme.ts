import type { GhosttyTheme } from "restty";
import type { ThemeColor } from "restty/internal";
import type { TerminalColors } from "shared/themes/types";

function hexToThemeColor(hex: string): ThemeColor {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return { r, g, b };
}

function maybeHex(hex: string | undefined): ThemeColor | undefined {
	return hex ? hexToThemeColor(hex) : undefined;
}

export function toResttyTheme(colors: Partial<TerminalColors>): GhosttyTheme {
	const bg = colors.background
		? hexToThemeColor(colors.background)
		: { r: 26, g: 26, b: 26 };
	const fg = colors.foreground
		? hexToThemeColor(colors.foreground)
		: { r: 212, g: 212, b: 212 };

	// Build palette from available colors, filtering undefined entries
	const paletteEntries = [
		maybeHex(colors.black),
		maybeHex(colors.red),
		maybeHex(colors.green),
		maybeHex(colors.yellow),
		maybeHex(colors.blue),
		maybeHex(colors.magenta),
		maybeHex(colors.cyan),
		maybeHex(colors.white),
		maybeHex(colors.brightBlack),
		maybeHex(colors.brightRed),
		maybeHex(colors.brightGreen),
		maybeHex(colors.brightYellow),
		maybeHex(colors.brightBlue),
		maybeHex(colors.brightMagenta),
		maybeHex(colors.brightCyan),
		maybeHex(colors.brightWhite),
	];

	return {
		colors: {
			background: bg,
			foreground: fg,
			cursor: maybeHex(colors.cursor),
			cursorText: maybeHex(colors.cursorAccent),
			selectionBackground: maybeHex(colors.selectionBackground),
			selectionForeground: maybeHex(colors.selectionForeground),
			palette: paletteEntries.filter((c): c is ThemeColor => c !== undefined),
		},
		raw: {},
	};
}
