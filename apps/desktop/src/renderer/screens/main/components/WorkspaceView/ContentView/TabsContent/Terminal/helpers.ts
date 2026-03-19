import { toast } from "@superset/ui/sonner";
import { debounce } from "lodash";
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
	RESIZE_DEBOUNCE_MS,
	TERMINAL_OPTIONS,
} from "./config";
import {
	ResttyAdapter,
	type ResttyAdapterOptions,
} from "./restty/ResttyAdapter";
import { ResttyLinkDetector } from "./restty/ResttyLinkDetector";
import type { TrpcPtyTransport } from "./restty/TrpcPtyTransport";
import { scrollToBottom } from "./utils";

/**
 * Get the default terminal theme from localStorage cache.
 * This reads cached terminal colors before store hydration to prevent flash.
 * Supports both built-in and custom themes via direct color cache.
 * Returns a GhosttyTheme for restty consumption.
 */
export function getDefaultTerminalTheme(): GhosttyTheme {
	try {
		// First try cached terminal colors (works for all themes including custom)
		const cachedTerminal = localStorage.getItem("theme-terminal");
		if (cachedTerminal) {
			return toResttyTheme(JSON.parse(cachedTerminal));
		}
		// Fallback to looking up by theme ID (for fresh installs before first theme apply)
		const themeId = localStorage.getItem("theme-id") ?? DEFAULT_THEME_ID;
		const theme = builtInThemes.find((t) => t.id === themeId);
		if (theme) {
			return toResttyTheme(getTerminalColors(theme));
		}
	} catch {
		// Fall through to default
	}
	// Final fallback to default theme
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
 * This reads from localStorage before store hydration to prevent flash.
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

export interface CreateTerminalOptions {
	cwd?: string;
	initialTheme?: GhosttyTheme | null;
	onFileLinkClick?: (path: string, line?: number, column?: number) => void;
	onUrlClickRef?: { current: ((url: string) => void) | undefined };
}

export function createTerminalInstance(
	container: HTMLDivElement,
	transport: TrpcPtyTransport,
	options: CreateTerminalOptions = {},
): {
	adapter: ResttyAdapter;
	linkDetector: ResttyLinkDetector;
	cleanup: () => void;
} {
	const { cwd, initialTheme, onFileLinkClick, onUrlClickRef: urlClickRef } =
		options;
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
			const handler = urlClickRef?.current;
			if (handler) {
				handler(url);
				return;
			}
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
// Keyboard Handler
// ============================================================================

export interface KeyboardHandlerOptions {
	/** Callback for Shift+Enter (sends ESC+CR to avoid \ appearing in Claude Code while keeping line continuation behavior) */
	onShiftEnter?: () => void;
	/** Callback for the configured clear terminal shortcut */
	onClear?: () => void;
	onWrite?: (data: string) => void;
}

/**
 * Setup keyboard handling for the terminal including:
 * - Shortcut forwarding: App hotkeys bubble to document where useAppHotkey listens
 * - Shift+Enter: Sends ESC+CR sequence (to avoid \ appearing in Claude Code while keeping line continuation behavior)
 * - Clear terminal: Uses the configured clear shortcut
 *
 * In restty, this is registered as a `beforeInput` interceptor rather than
 * xterm's `attachCustomKeyEventHandler`. The handler returns false to suppress
 * the key or true to allow it.
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

		// Cmd+Left: Move cursor to beginning of line (sends Ctrl+A)
		const isCmdLeft =
			event.key === "ArrowLeft" &&
			event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCmdLeft) {
			if (event.type === "keydown" && options.onWrite) {
				event.preventDefault();
				options.onWrite("\x01"); // Ctrl+A - beginning of line
			}
			return false;
		}

		// Cmd+Right: Move cursor to end of line (sends Ctrl+E)
		const isCmdRight =
			event.key === "ArrowRight" &&
			event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCmdRight) {
			if (event.type === "keydown" && options.onWrite) {
				event.preventDefault();
				options.onWrite("\x05"); // Ctrl+E - end of line
			}
			return false;
		}

		// Option+Left/Right (macOS): word navigation (Meta+B / Meta+F)
		const isOptionLeft =
			event.key === "ArrowLeft" &&
			event.altKey &&
			isMac &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.shiftKey;

		if (isOptionLeft) {
			if (event.type === "keydown" && options.onWrite) {
				options.onWrite("\x1bb"); // Meta+B - backward word
			}
			return false;
		}

		// Option+Right: Move cursor forward by word (Meta+F)
		const isOptionRight =
			event.key === "ArrowRight" &&
			event.altKey &&
			isMac &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.shiftKey;

		if (isOptionRight) {
			if (event.type === "keydown" && options.onWrite) {
				options.onWrite("\x1bf"); // Meta+F - forward word
			}
			return false;
		}

		// Ctrl+Left/Right (Windows): word navigation (Meta+B / Meta+F)
		const isCtrlLeft =
			event.key === "ArrowLeft" &&
			event.ctrlKey &&
			isWindows &&
			!event.metaKey &&
			!event.altKey &&
			!event.shiftKey;

		if (isCtrlLeft) {
			if (event.type === "keydown" && options.onWrite) {
				options.onWrite("\x1bb"); // Meta+B - backward word
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
				options.onWrite("\x1bf"); // Meta+F - forward word
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
			// Return false to prevent the terminal from processing the key.
			// The original event bubbles to document where useAppHotkey handles it.
			return false;
		}

		return true;
	};
}

export interface PasteHandlerOptions {
	/** Callback when text is pasted, receives the pasted text */
	onPaste?: (text: string) => void;
	/** Optional direct write callback */
	onWrite?: (data: string) => void;
	/** Whether bracketed paste mode is enabled for the current terminal */
	isBracketedPasteEnabled?: () => boolean;
}

/**
 * Setup paste handler on a container element.
 * Handles chunked paste logic for large pastes and bracketed paste wrapping.
 * Also handles the Ctrl+V forward for non-text clipboard payloads.
 *
 * Returns a cleanup function to remove the handler.
 */
export function setupPasteHandler(
	container: HTMLElement,
	options: PasteHandlerOptions = {},
): () => void {
	let cancelActivePaste: (() => void) | null = null;

	const shouldForwardCtrlVForNonTextPaste = (
		event: ClipboardEvent,
		text: string,
	): boolean => {
		if (text) return false;
		const types = Array.from(event.clipboardData?.types ?? []);
		if (types.length === 0) return false;
		return types.some((type) => type !== "text/plain");
	};

	const handlePaste = (event: ClipboardEvent) => {
		const text = event.clipboardData?.getData("text/plain") ?? "";
		if (!text) {
			// Match terminal behavior like iTerm's "Paste or send ^V":
			// when clipboard has non-text payloads but no plain text, forward Ctrl+V.
			if (options.onWrite && shouldForwardCtrlVForNonTextPaste(event, text)) {
				event.preventDefault();
				event.stopImmediatePropagation();
				options.onWrite("\x16");
			}
			return;
		}

		// Only intercept if we have a direct write callback for custom handling
		if (!options.onWrite) return;

		event.preventDefault();
		event.stopImmediatePropagation();

		options.onPaste?.(text);

		// Cancel any in-flight chunked paste to avoid overlapping writes.
		cancelActivePaste?.();
		cancelActivePaste = null;

		// Chunk large pastes to avoid sending a single massive input burst that can
		// overwhelm the PTY pipeline (especially when the app is repainting heavily).
		const MAX_SYNC_PASTE_CHARS = 16_384;

		// Direct write path: replicate xterm's paste normalization, but stream in
		// controlled chunks while preserving bracketed-paste semantics.
		const preparedText = text.replace(/\r?\n/g, "\r");
		const bracketedPasteEnabled = options.isBracketedPasteEnabled?.() ?? false;
		const shouldBracket = bracketedPasteEnabled;

		// For small/medium pastes, preserve the fast path and avoid timers.
		if (preparedText.length <= MAX_SYNC_PASTE_CHARS) {
			options.onWrite(
				shouldBracket ? `\x1b[200~${preparedText}\x1b[201~` : preparedText,
			);
			return;
		}

		let cancelled = false;
		let offset = 0;
		const CHUNK_CHARS = 16_384;
		const CHUNK_DELAY_MS = 0;

		const pasteNext = () => {
			if (cancelled) return;

			const chunk = preparedText.slice(offset, offset + CHUNK_CHARS);
			offset += CHUNK_CHARS;

			if (shouldBracket) {
				// Wrap each chunk to avoid long-running "open" bracketed paste blocks,
				// which some TUIs may defer repainting until the closing sequence arrives.
				options.onWrite?.(`\x1b[200~${chunk}\x1b[201~`);
			} else {
				options.onWrite?.(chunk);
			}

			if (offset < preparedText.length) {
				setTimeout(pasteNext, CHUNK_DELAY_MS);
				return;
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
 * Setup copy handler for the terminal container to trim trailing whitespace from copied text.
 *
 * Terminal emulators fill lines with whitespace to pad to the terminal width.
 * When copying text, this results in unwanted trailing spaces on each line.
 * This handler intercepts copy events and trims trailing whitespace from each
 * line before writing to the clipboard.
 *
 * Returns a cleanup function to remove the handler.
 */
export function setupCopyHandler(
	container: HTMLElement,
	getSelection: () => string,
): () => void {
	const handleCopy = (event: ClipboardEvent) => {
		const selection = getSelection();
		if (!selection) return;

		// Trim trailing whitespace from each line while preserving intentional newlines
		const trimmedText = selection
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n");

		// On Linux/Wayland in Electron, clipboardData can be null for copy events.
		// Only cancel default behavior when we can write directly to event clipboardData.
		if (event.clipboardData) {
			event.preventDefault();
			event.clipboardData.setData("text/plain", trimmedText);
			return;
		}

		// Fallback path when clipboardData is unavailable.
		// Keep default browser copy behavior and best-effort write trimmed text.
		void navigator.clipboard?.writeText(trimmedText).catch(() => {});
	};

	container.addEventListener("copy", handleCopy);

	return () => {
		container.removeEventListener("copy", handleCopy);
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

export function setupResizeHandlers(
	container: HTMLDivElement,
	adapter: ResttyAdapter,
	onResize: (cols: number, rows: number) => void,
): () => void {
	const debouncedHandleResize = debounce(() => {
		adapter.fit();
		const { cols, rows } = adapter.getDimensions();
		onResize(cols, rows);
		requestAnimationFrame(() => scrollToBottom(adapter));
	}, RESIZE_DEBOUNCE_MS);

	const resizeObserver = new ResizeObserver(debouncedHandleResize);
	resizeObserver.observe(container);
	window.addEventListener("resize", debouncedHandleResize);

	return () => {
		window.removeEventListener("resize", debouncedHandleResize);
		resizeObserver.disconnect();
		debouncedHandleResize.cancel();
	};
}

export interface ClickToMoveOptions {
	/** Callback to write data to the terminal PTY */
	onWrite: (data: string) => void;
}

/**
 * Setup click-to-move cursor functionality.
 * Allows clicking on the current prompt line to move the cursor to that position.
 *
 * This works by calculating the difference between click position and cursor position,
 * then sending the appropriate number of arrow key sequences to move the cursor.
 *
 * Limitations:
 * - Only works on the current line (same row as cursor)
 * - Only works at the shell prompt (not in full-screen apps like vim)
 * - Requires the shell to interpret arrow key sequences
 *
 * Returns a cleanup function to remove the handler.
 */
export function setupClickToMoveCursor(
	adapter: ResttyAdapter,
	options: ClickToMoveOptions,
): () => void {
	const container = adapter.container;

	const handleClick = (event: MouseEvent) => {
		if (event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
			return;

		const coords = adapter.getCursorCoords(event);
		if (!coords) return;

		const { clickCol, cursorCol, isOnCursorRow } = coords;
		if (!isOnCursorRow) return;

		const delta = clickCol - cursorCol;
		if (delta === 0) return;

		// Right arrow: \x1b[C, Left arrow: \x1b[D
		const arrowKey = delta > 0 ? "\x1b[C" : "\x1b[D";
		options.onWrite(arrowKey.repeat(Math.abs(delta)));
	};

	container.addEventListener("click", handleClick);

	return () => {
		container.removeEventListener("click", handleClick);
	};
}
