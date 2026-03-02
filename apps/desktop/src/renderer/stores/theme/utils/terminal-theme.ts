import type { GhosttyTheme } from "restty";
import type { ThemeColor } from "restty/internal";
import type { TerminalColors } from "shared/themes/types";

function hexToThemeColor(hex: string): ThemeColor {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return { r, g, b };
}

export function toResttyTheme(colors: TerminalColors): GhosttyTheme {
	return {
		colors: {
			background: hexToThemeColor(colors.background),
			foreground: hexToThemeColor(colors.foreground),
			cursor: hexToThemeColor(colors.cursor),
			cursorText: colors.cursorAccent
				? hexToThemeColor(colors.cursorAccent)
				: undefined,
			selectionBackground: colors.selectionBackground
				? hexToThemeColor(colors.selectionBackground)
				: undefined,
			selectionForeground: colors.selectionForeground
				? hexToThemeColor(colors.selectionForeground)
				: undefined,
			palette: [
				hexToThemeColor(colors.black), // 0
				hexToThemeColor(colors.red), // 1
				hexToThemeColor(colors.green), // 2
				hexToThemeColor(colors.yellow), // 3
				hexToThemeColor(colors.blue), // 4
				hexToThemeColor(colors.magenta), // 5
				hexToThemeColor(colors.cyan), // 6
				hexToThemeColor(colors.white), // 7
				hexToThemeColor(colors.brightBlack), // 8
				hexToThemeColor(colors.brightRed), // 9
				hexToThemeColor(colors.brightGreen), // 10
				hexToThemeColor(colors.brightYellow), // 11
				hexToThemeColor(colors.brightBlue), // 12
				hexToThemeColor(colors.brightMagenta), // 13
				hexToThemeColor(colors.brightCyan), // 14
				hexToThemeColor(colors.brightWhite), // 15
			],
		},
		raw: {},
	};
}
