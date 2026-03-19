import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { DiffsThemeNames } from "@pierre/diffs/react";
import type { CSSProperties } from "react";
import {
	DEFAULT_CODE_EDITOR_FONT_FAMILY,
	DEFAULT_CODE_EDITOR_FONT_SIZE,
	MIDNIGHT_CODE_COLORS,
} from "../components/CodeEditor/constants";

interface CodeThemeFontSettings {
	fontFamily?: string;
	fontSize?: number;
}

const MIDNIGHT_DIFF_THEME = {
	light: "one-light" as DiffsThemeNames,
	dark: "one-dark-pro" as DiffsThemeNames,
};

const MIDNIGHT_DIFF_COLORS = {
	background: MIDNIGHT_CODE_COLORS.background,
	buffer: "#1a1716",
	hover: "#201c1a",
	separator: "#1a1716",
	lineNumber: MIDNIGHT_CODE_COLORS.muted,
	addition: MIDNIGHT_CODE_COLORS.addition,
	deletion: MIDNIGHT_CODE_COLORS.deletion,
	modified: MIDNIGHT_CODE_COLORS.modified,
	selection: MIDNIGHT_CODE_COLORS.selection,
	additionBar: "#3fb950",
	deletionBar: "#d4614a",
};

export function getDiffsTheme() {
	return MIDNIGHT_DIFF_THEME;
}

let cachedSyntaxHighlighting: Extension | null = null;

export function getCodeSyntaxHighlighting(): Extension {
	if (!cachedSyntaxHighlighting) {
		cachedSyntaxHighlighting = syntaxHighlighting(oneDarkHighlightStyle);
	}
	return cachedSyntaxHighlighting;
}

export function getDiffViewerStyle(
	fontSettings: CodeThemeFontSettings,
): CSSProperties {
	const fontFamily = fontSettings.fontFamily ?? DEFAULT_CODE_EDITOR_FONT_FAMILY;
	const fontSize = fontSettings.fontSize ?? DEFAULT_CODE_EDITOR_FONT_SIZE;
	const lineHeight = Math.round(fontSize * 1.5);

	return {
		"--diffs-font-family": fontFamily,
		"--diffs-font-size": `${fontSize}px`,
		"--diffs-line-height": `${lineHeight}px`,
		"--diffs-bg-buffer-override": MIDNIGHT_DIFF_COLORS.buffer,
		"--diffs-bg-hover-override": MIDNIGHT_DIFF_COLORS.hover,
		"--diffs-bg-context-override": MIDNIGHT_DIFF_COLORS.background,
		"--diffs-bg-separator-override": MIDNIGHT_DIFF_COLORS.separator,
		"--diffs-fg-number-override": MIDNIGHT_DIFF_COLORS.lineNumber,
		"--diffs-addition-color-override": MIDNIGHT_DIFF_COLORS.addition,
		"--diffs-deletion-color-override": MIDNIGHT_DIFF_COLORS.deletion,
		"--diffs-modified-color-override": MIDNIGHT_DIFF_COLORS.modified,
		"--diffs-selection-color-override": MIDNIGHT_DIFF_COLORS.selection,
		"--diffs-fg-number-addition-override": "rgba(63, 185, 80, 0.9)",
		"--diffs-fg-number-deletion-override": "rgba(212, 97, 74, 0.9)",
		// Override the row and gutter backgrounds directly — the library's default
		// formula (color-mix bg 80% + color 20%) produces an imperceptibly faint wash.
		"--diffs-bg-addition-override": "rgba(0, 162, 64, 0.18)",
		"--diffs-bg-addition-number-override": "rgba(0, 162, 64, 0.12)",
		"--diffs-bg-addition-hover-override": "rgba(0, 162, 64, 0.25)",
		"--diffs-bg-deletion-override": "rgba(212, 97, 74, 0.18)",
		"--diffs-bg-deletion-number-override": "rgba(212, 97, 74, 0.12)",
		"--diffs-bg-deletion-hover-override": "rgba(212, 97, 74, 0.25)",
		"--diffs-bg-addition-emphasis-override": "rgba(0, 162, 64, 0.40)",
		"--diffs-bg-deletion-emphasis-override": "rgba(212, 97, 74, 0.45)",
		"--diffs-addition-bar-color": MIDNIGHT_DIFF_COLORS.additionBar,
		"--diffs-deletion-bar-color": MIDNIGHT_DIFF_COLORS.deletionBar,
		backgroundColor: MIDNIGHT_DIFF_COLORS.background,
		color: MIDNIGHT_CODE_COLORS.foreground,
	} as CSSProperties;
}
