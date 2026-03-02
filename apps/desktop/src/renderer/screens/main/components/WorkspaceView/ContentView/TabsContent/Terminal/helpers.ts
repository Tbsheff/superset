import { toast } from "@superset/ui/sonner";
import { electronTrpcClient as trpcClient } from "renderer/lib/trpc-client";
import { getHotkeyKeys, isAppHotkeyEvent } from "renderer/stores/hotkeys";
import { toResttyTheme } from "renderer/stores/theme/utils";
import type { GhosttyTheme } from "restty";
import {
	getCurrentPlatform,
	hotkeyFromKeyboardEvent,
	isTerminalReservedEvent,
	matchesHotkeyEvent,
} from "shared/hotkeys";
import {
	builtInThemes,
	DEFAULT_THEME_ID,
	getTerminalColors,
} from "shared/themes";
import {
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
	TERMINAL_OPTIONS,
} from "./config";
import {
	ResttyAdapter,
	type ResttyAdapterOptions,
} from "./restty/ResttyAdapter";
import { ResttyLinkDetector } from "./restty/ResttyLinkDetector";
import type { TrpcPtyTransport } from "./restty/TrpcPtyTransport";

/**
 * Get the default terminal theme from localStorage cache.
 * Returns a GhosttyTheme for restty consumption.
 */
export function getDefaultTerminalTheme(): GhosttyTheme {
	try {
		const cachedTerminal = localStorage.getItem("theme-terminal");
		if (cachedTerminal) {
			return toResttyTheme(JSON.parse(cachedTerminal));
		}
		const themeId = localStorage.getItem("theme-id") ?? DEFAULT_THEME_ID;
		const theme = builtInThemes.find((t) => t.id === themeId);
		if (theme) {
			return toResttyTheme(getTerminalColors(theme));
		}
	} catch {
		// Fall through to default
	}
	const defaultTheme = builtInThemes.find((t) => t.id === DEFAULT_THEME_ID);
	return defaultTheme
		? toResttyTheme(getTerminalColors(defaultTheme))
		: {
				colors: {
					background: { r: 26, g: 26, b: 26 },
					foreground: { r: 212, g: 212, b: 212 },
					palette: [],
				},
				raw: {},
			};
}

/**
 * Get the default terminal background based on stored theme.
 */
export function getDefaultTerminalBg(): string {
	try {
		const cachedTerminal = localStorage.getItem("theme-terminal");
		if (cachedTerminal) {
			const colors = JSON.parse(cachedTerminal);
			return colors.background ?? "#1a1a1a";
		}
	} catch {
		// Fall through
	}
	return "#1a1a1a";
}

// ============================================================================
// Terminal Instance Creation
// ============================================================================

export interface CreateResttyOptions {
	cwd?: string;
	initialTheme?: GhosttyTheme | null;
	onFileLinkClick?: (path: string, line?: number, column?: number) => void;
}

export function createResttyInstance(
	container: HTMLDivElement,
	transport: TrpcPtyTransport,
	options: CreateResttyOptions = {},
): {
	adapter: ResttyAdapter;
	linkDetector: ResttyLinkDetector;
	cleanup: () => void;
} {
	const { cwd, initialTheme, onFileLinkClick } = options;
	const theme = initialTheme ?? getDefaultTerminalTheme();

	// Build font sources from config font family list
	const fontMatchers = DEFAULT_TERMINAL_FONT_FAMILY.split(",")
		.map((f) => f.trim().replace(/^["']|["']$/g, ""))
		.filter((f) => f !== "monospace" && f.length > 0);

	const adapterOptions: ResttyAdapterOptions = {
		fontSize: TERMINAL_OPTIONS.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
		scrollback: TERMINAL_OPTIONS.scrollback ?? 10_000,
		theme,
		fontSources: fontMatchers.map((matcher) => ({
			type: "local" as const,
			matchers: [matcher],
			label: matcher,
		})),
	};

	const adapter = new ResttyAdapter({
		container,
		transport,
		options: adapterOptions,
	});

	// Setup link detection
	const linkDetector = new ResttyLinkDetector({
		getRenderState: () => {
			// Access WASM render state through restty's active pane
			const pane = adapter.restty.getActivePane();
			if (!pane?.app) return null;
			// RenderState is accessed through the WASM runtime internally
			// For now, link detection will rely on DOM-based hover detection
			return null;
		},
		getCellDimensions: () => adapter.getCellDimensions(),
		onFileLinkClick: (path, line, column) => {
			if (onFileLinkClick) {
				onFileLinkClick(path, line, column);
			} else {
				trpcClient.external.openFileInEditor
					.mutate({ path, line, column, cwd })
					.catch((error) => {
						console.error("[Terminal] Failed to open file:", path, error);
					});
			}
		},
		onUrlClick: (url) => {
			trpcClient.external.openUrl.mutate(url).catch((error) => {
				console.error("[Terminal] Failed to open URL:", url, error);
				toast.error("Failed to open URL", {
					description:
						error instanceof Error
							? error.message
							: "Could not open URL in browser",
				});
			});
		},
		container,
	});

	linkDetector.attach();

	return {
		adapter,
		linkDetector,
		cleanup: () => {
			linkDetector.dispose();
			adapter.dispose();
		},
	};
}

// ============================================================================
// Keyboard Handler (preserved from xterm.js — logic is not xterm-specific)
// ============================================================================

export interface KeyboardHandlerOptions {
	onShiftEnter?: () => void;
	onClear?: () => void;
	onWrite?: (data: string) => void;
}

/**
 * Setup keyboard handling for the terminal.
 *
 * In restty, this is registered as a `beforeInput` interceptor rather than
 * xterm's `attachCustomKeyEventHandler`. The keyboard handler function itself
 * is the same — it returns false to suppress the key or true to allow it.
 *
 * Returns the handler function that can be used with restty's input interceptor.
 */
export function createKeyboardHandler(
	options: KeyboardHandlerOptions = {},
): (event: KeyboardEvent) => boolean {
	const platform =
		typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "";
	const isMac = platform.includes("mac");
	const isWindows = platform.includes("win");

	return (event: KeyboardEvent): boolean => {
		const isShiftEnter =
			event.key === "Enter" &&
			event.shiftKey &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey;

		if (isShiftEnter) {
			if (event.type === "keydown" && options.onShiftEnter) {
				event.preventDefault();
				options.onShiftEnter();
			}
			return false;
		}

		const isCmdBackspace =
			event.key === "Backspace" &&
			event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCmdBackspace) {
			if (event.type === "keydown" && options.onWrite) {
				event.preventDefault();
				options.onWrite("\x15\x1b[D"); // Ctrl+U + left arrow
			}
			return false;
		}

		const isCmdLeft =
			event.key === "ArrowLeft" &&
			event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCmdLeft) {
			if (event.type === "keydown" && options.onWrite) {
				event.preventDefault();
				options.onWrite("\x01"); // Ctrl+A
			}
			return false;
		}

		const isCmdRight =
			event.key === "ArrowRight" &&
			event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCmdRight) {
			if (event.type === "keydown" && options.onWrite) {
				event.preventDefault();
				options.onWrite("\x05"); // Ctrl+E
			}
			return false;
		}

		const isOptionLeft =
			event.key === "ArrowLeft" &&
			event.altKey &&
			isMac &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.shiftKey;

		if (isOptionLeft) {
			if (event.type === "keydown" && options.onWrite) {
				options.onWrite("\x1bb"); // Meta+B
			}
			return false;
		}

		const isOptionRight =
			event.key === "ArrowRight" &&
			event.altKey &&
			isMac &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.shiftKey;

		if (isOptionRight) {
			if (event.type === "keydown" && options.onWrite) {
				options.onWrite("\x1bf"); // Meta+F
			}
			return false;
		}

		const isCtrlLeft =
			event.key === "ArrowLeft" &&
			event.ctrlKey &&
			isWindows &&
			!event.metaKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCtrlLeft) {
			if (event.type === "keydown" && options.onWrite) {
				options.onWrite("\x1bb"); // Meta+B
			}
			return false;
		}

		const isCtrlRight =
			event.key === "ArrowRight" &&
			event.ctrlKey &&
			isWindows &&
			!event.metaKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCtrlRight) {
			if (event.type === "keydown" && options.onWrite) {
				options.onWrite("\x1bf"); // Meta+F
			}
			return false;
		}

		if (isTerminalReservedEvent(event)) return true;

		const clearKeys = getHotkeyKeys("CLEAR_TERMINAL");
		const isClearShortcut =
			clearKeys !== null && matchesHotkeyEvent(event, clearKeys);

		if (isClearShortcut) {
			if (event.type === "keydown" && options.onClear) {
				options.onClear();
			}
			return false;
		}

		if (event.type !== "keydown") return true;
		const potentialHotkey = hotkeyFromKeyboardEvent(
			event,
			getCurrentPlatform(),
		);
		if (!potentialHotkey) return true;

		if (isAppHotkeyEvent(event)) {
			return false;
		}

		return true;
	};
}

export interface PasteHandlerOptions {
	onPaste?: (text: string) => void;
	onWrite?: (data: string) => void;
	isBracketedPasteEnabled?: () => boolean;
}

/**
 * Setup paste handler on a container element.
 * restty handles most paste natively, but we keep the chunked paste logic
 * for large pastes and the bracketed paste wrapping.
 */
export function setupPasteHandler(
	container: HTMLElement,
	options: PasteHandlerOptions = {},
): () => void {
	let cancelActivePaste: (() => void) | null = null;

	const handlePaste = (event: ClipboardEvent) => {
		const text = event.clipboardData?.getData("text/plain");
		if (!text) return;

		// Only intercept if we have a direct write callback for custom handling
		if (!options.onWrite) return;

		event.preventDefault();
		event.stopImmediatePropagation();

		options.onPaste?.(text);
		cancelActivePaste?.();
		cancelActivePaste = null;

		const MAX_SYNC_PASTE_CHARS = 16_384;
		const preparedText = text.replace(/\r?\n/g, "\r");
		const bracketedPasteEnabled = options.isBracketedPasteEnabled?.() ?? false;

		if (preparedText.length <= MAX_SYNC_PASTE_CHARS) {
			options.onWrite(
				bracketedPasteEnabled
					? `\x1b[200~${preparedText}\x1b[201~`
					: preparedText,
			);
			return;
		}

		let cancelled = false;
		let offset = 0;
		const CHUNK_CHARS = 16_384;

		const pasteNext = () => {
			if (cancelled) return;
			const chunk = preparedText.slice(offset, offset + CHUNK_CHARS);
			offset += CHUNK_CHARS;

			if (bracketedPasteEnabled) {
				options.onWrite?.(`\x1b[200~${chunk}\x1b[201~`);
			} else {
				options.onWrite?.(chunk);
			}

			if (offset < preparedText.length) {
				setTimeout(pasteNext, 0);
			}
		};

		cancelActivePaste = () => {
			cancelled = true;
		};

		pasteNext();
	};

	container.addEventListener("paste", handlePaste, { capture: true });

	return () => {
		cancelActivePaste?.();
		cancelActivePaste = null;
		container.removeEventListener("paste", handlePaste, { capture: true });
	};
}

/**
 * Setup focus listener on the terminal container.
 */
export function setupFocusListener(
	container: HTMLElement,
	onFocus: () => void,
): () => void {
	container.addEventListener("focus", onFocus, true);
	return () => {
		container.removeEventListener("focus", onFocus, true);
	};
}
