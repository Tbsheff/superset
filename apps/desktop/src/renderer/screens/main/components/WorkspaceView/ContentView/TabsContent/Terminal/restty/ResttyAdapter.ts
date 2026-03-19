/**
 * ResttyAdapter — Compatibility layer wrapping a Restty instance.
 *
 * Exposes the subset of APIs that Terminal hooks need, bridging restty's
 * native API with the interface shapes the existing hooks expect.
 *
 * NOT using restty/xterm compat layer because it's too limited
 * (missing onWriteParsed, onScroll, buffer access, parser, ILinkProvider).
 */

import {
	type GhosttyTheme,
	Restty,
	type ResttyFontSource,
	type ResttyOptions,
} from "restty";

import type { TrpcPtyTransport } from "./TrpcPtyTransport";

// ============================================================================
// Types
// ============================================================================

export interface ResttyAdapterOptions {
	fontSize?: number;
	scrollback?: number;
	theme?: GhosttyTheme;
	fontSources?: ResttyFontSource[];
}

interface Disposable {
	dispose: () => void;
}

type Listener<T = void> = T extends void ? () => void : (payload: T) => void;

// ============================================================================
// Adapter Class
// ============================================================================

export class ResttyAdapter {
	private readonly _restty: Restty;
	private readonly _transport: TrpcPtyTransport;
	private _disposed = false;

	// Listener buckets
	private readonly _dataListeners = new Set<Listener<string>>();
	private readonly _scrollListeners = new Set<Listener>();
	private readonly _writeParsedListeners = new Set<Listener>();
	private readonly _titleChangeListeners = new Set<Listener<string>>();

	// Cached dimensions (updated via callbacks)
	private _cols = 80;
	private _rows = 24;
	private _cellWidth = 0;
	private _cellHeight = 0;
	private _cursorCol = 0;
	private _cursorRow = 0;

	// Chunked write buffer to prevent OOM during session restore
	private _writeQueue: Array<{ data: string; callback?: () => void }> = [];
	private _isWriting = false;
	private static readonly CHUNK_SIZE = 16_384; // 16KB per chunk

	constructor(opts: {
		container: HTMLElement;
		transport: TrpcPtyTransport;
		options?: ResttyAdapterOptions;
	}) {
		this._transport = opts.transport;

		const resttyOpts: ResttyOptions = {
			root: opts.container,
			appOptions: {
				fontSize: opts.options?.fontSize ?? 14,
				fontPreset: "none",
				fontSources: opts.options?.fontSources,
				autoResize: true,
				attachWindowEvents: false,
				attachCanvasEvents: true,
				ptyTransport: opts.transport,
				maxScrollback: (opts.options?.scrollback ?? 10_000) * 200,
				callbacks: {
					onTermSize: (cols, rows) => {
						this._cols = cols;
						this._rows = rows;
					},
					onCellSize: (cellW, cellH) => {
						this._cellWidth = cellW;
						this._cellHeight = cellH;
					},
					onCursor: (col, row) => {
						this._cursorCol = col;
						this._cursorRow = row;
					},
				},
				beforeInput: (payload) => {
					for (const listener of this._dataListeners) {
						listener(payload.text);
					}
					return payload.text;
				},
			},
			defaultContextMenu: false,
			shortcuts: false,
			createInitialPane: true,
		};

		this._restty = new Restty(resttyOpts);

		// Connect the PTY transport so restty calls transport.connect() and
		// sets up the callbacks (onData, onConnect, etc.). Without this call,
		// transport.callbacks is null and feedData() silently does nothing.
		this._restty.connectPty();

		// Apply theme after creation
		if (opts.options?.theme) {
			this._restty.applyTheme(opts.options.theme);
		}
	}

	// ==========================================================================
	// Properties
	// ==========================================================================

	get restty(): Restty {
		return this._restty;
	}

	get transport(): TrpcPtyTransport {
		return this._transport;
	}

	get cols(): number {
		return this._cols;
	}

	get rows(): number {
		return this._rows;
	}

	get cellWidth(): number {
		return this._cellWidth;
	}

	get cellHeight(): number {
		return this._cellHeight;
	}

	get disposed(): boolean {
		return this._disposed;
	}

	// ==========================================================================
	// Core Methods
	// ==========================================================================

	/**
	 * Feed ANSI data into restty's WASM VT parser (used by restore flows).
	 * Data is written through the transport's feedData which triggers the
	 * onData callback in restty's PTY connection handler.
	 */
	write(data: string, callback?: () => void): void {
		if (this._disposed) return;
		this._writeQueue.push({ data, callback });
		if (!this._isWriting) {
			this._drainQueue();
		}
	}

	private _drainQueue(): void {
		this._isWriting = true;
		const item = this._writeQueue[0];
		if (!item) {
			this._isWriting = false;
			return;
		}

		const chunk = item.data.substring(0, ResttyAdapter.CHUNK_SIZE);
		item.data = item.data.substring(ResttyAdapter.CHUNK_SIZE);

		// Feed chunk to restty
		this._transport.feedData(chunk);

		if (item.data.length === 0) {
			this._writeQueue.shift();
			item.callback?.();
			// Notify write-parsed listeners after full item completes
			for (const listener of this._writeParsedListeners) {
				listener();
			}
		}

		if (this._writeQueue.length > 0 || item.data.length > 0) {
			setTimeout(() => this._drainQueue(), 0);
		} else {
			this._isWriting = false;
		}
	}

	writeln(data: string): void {
		this.write(`${data}\r\n`);
	}

	clear(): void {
		if (this._disposed) return;
		this._restty.clearScreen();
	}

	focus(): void {
		if (this._disposed) return;
		this._restty.focus();
	}

	blur(): void {
		if (this._disposed) return;
		this._restty.blur();
	}

	resize(cols: number, rows: number): void {
		if (this._disposed) return;
		this._restty.resize(cols, rows);
	}

	sendInput(data: string): void {
		if (this._disposed) return;
		this._restty.sendInput(data);
	}

	async copySelectionToClipboard(): Promise<boolean> {
		if (this._disposed) return false;
		return this._restty.copySelectionToClipboard();
	}

	async pasteFromClipboard(): Promise<boolean> {
		if (this._disposed) return false;
		return this._restty.pasteFromClipboard();
	}

	setFontSize(size: number): void {
		if (this._disposed) return;
		this._restty.setFontSize(size);
	}

	applyTheme(theme: GhosttyTheme): void {
		if (this._disposed) return;
		this._restty.applyTheme(theme);
	}

	updateSize(force?: boolean): void {
		if (this._disposed) return;
		this._restty.updateSize(force);
	}

	clearScreen(): void {
		if (this._disposed) return;
		this._restty.clearScreen();
	}

	setRenderer(value: "auto" | "webgpu" | "webgl2"): void {
		if (this._disposed) return;
		this._restty.setRenderer(value);
	}

	/**
	 * Scroll viewport by delta rows. Negative = scroll up, positive = scroll down.
	 */
	scrollViewport(delta: number): void {
		if (this._disposed) return;
		// Access the active pane's raw app for scroll control
		const pane = this._restty.getActivePane();
		if (!pane?.app) return;
		// sendInput with scroll escape sequences, or use WASM scroll directly
		// For now, use keyboard-based scrolling
		if (delta > 0) {
			// Scroll down
			for (let i = 0; i < delta; i++) {
				this._restty.sendKeyInput("\x1b[B");
			}
		} else {
			// Scroll up
			for (let i = 0; i < Math.abs(delta); i++) {
				this._restty.sendKeyInput("\x1b[A");
			}
		}
	}

	/**
	 * Scroll to the bottom of the terminal output.
	 */
	scrollToBottom(): void {
		if (this._disposed) return;
		// Send a very large positive scroll to ensure we hit bottom
		// restty should clamp this internally
		this.scrollViewport(999_999);
	}

	/**
	 * Check if viewport is scrolled to the bottom.
	 * (Approximation — restty doesn't expose this directly yet)
	 */
	isAtBottom(): boolean {
		// TODO: When restty exposes scrollbar state, use restty_scrollbar_offset + len === total
		return true;
	}

	// ==========================================================================
	// Event Registration
	// ==========================================================================

	/**
	 * Called when terminal generates input data (user keystrokes).
	 * In restty, this fires via the beforeInput hook.
	 */
	onData(listener: Listener<string>): Disposable {
		this._dataListeners.add(listener);
		return {
			dispose: () => {
				this._dataListeners.delete(listener);
			},
		};
	}

	/**
	 * Called after data has been written and parsed.
	 */
	onWriteParsed(listener: Listener): Disposable {
		this._writeParsedListeners.add(listener);
		return {
			dispose: () => {
				this._writeParsedListeners.delete(listener);
			},
		};
	}

	/**
	 * Called when the viewport scrolls.
	 */
	onScroll(listener: Listener): Disposable {
		this._scrollListeners.add(listener);
		return {
			dispose: () => {
				this._scrollListeners.delete(listener);
			},
		};
	}

	/**
	 * Called when the terminal title changes (OSC 0/1/2).
	 */
	onTitleChange(listener: Listener<string>): Disposable {
		this._titleChangeListeners.add(listener);
		return {
			dispose: () => {
				this._titleChangeListeners.delete(listener);
			},
		};
	}

	/**
	 * Emit a scroll event (called by scroll detection logic).
	 */
	emitScroll(): void {
		for (const listener of this._scrollListeners) {
			listener();
		}
	}

	/**
	 * Emit a title change event.
	 */
	emitTitleChange(title: string): void {
		for (const listener of this._titleChangeListeners) {
			listener(title);
		}
	}

	/**
	 * Get cell dimensions for coordinate calculations.
	 */
	getCellDimensions(): { width: number; height: number } | null {
		if (this._cellWidth === 0 || this._cellHeight === 0) return null;
		return { width: this._cellWidth, height: this._cellHeight };
	}

	/**
	 * Get current cursor position (tracked via onCursor callback).
	 */
	getCursorPosition(): { col: number; row: number } {
		return { col: this._cursorCol, row: this._cursorRow };
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this._transport.destroy();
		this._restty.destroy();
		this._writeQueue.length = 0;
		this._dataListeners.clear();
		this._scrollListeners.clear();
		this._writeParsedListeners.clear();
		this._titleChangeListeners.clear();
	}
}
