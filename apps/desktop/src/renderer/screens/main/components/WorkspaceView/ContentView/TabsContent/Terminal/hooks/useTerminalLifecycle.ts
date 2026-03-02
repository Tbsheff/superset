import type { MutableRefObject, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import { killTerminalForPane } from "renderer/stores/tabs/utils/terminal-cleanup";
import type { GhosttyTheme } from "restty";
import { scheduleTerminalAttach } from "../attach-scheduler";
import { sanitizeForTitle } from "../commandBuffer";
import { DEBUG_TERMINAL, FIRST_RENDER_RESTORE_FALLBACK_MS } from "../config";
import {
	createKeyboardHandler,
	createResttyInstance,
	setupFocusListener,
	setupPasteHandler,
} from "../helpers";
import { isPaneDestroyed } from "../pane-guards";
import { setupClickToMoveCursor } from "../restty/click-to-move";
import type { ResttyAdapter } from "../restty/ResttyAdapter";
import { SearchShim } from "../restty/SearchShim";
import { TrpcPtyTransport } from "../restty/TrpcPtyTransport";
import { coldRestoreState, pendingDetaches } from "../state";
import type {
	CreateOrAttachMutate,
	CreateOrAttachResult,
	TerminalClearScrollbackMutate,
	TerminalDetachMutate,
	TerminalResizeMutate,
	TerminalWriteMutate,
} from "../types";
import { scrollToBottom } from "../utils";

type RegisterCallback = (paneId: string, callback: () => void) => void;
type UnregisterCallback = (paneId: string) => void;

const attachInFlightByPane = new Map<string, number>();
const attachWaitersByPane = new Map<string, Set<() => void>>();

function markAttachInFlight(paneId: string, attachId: number): void {
	attachInFlightByPane.set(paneId, attachId);
}

function clearAttachInFlight(paneId: string, attachId?: number): void {
	if (attachId !== undefined) {
		const current = attachInFlightByPane.get(paneId);
		if (current !== attachId) return;
	}
	attachInFlightByPane.delete(paneId);
	const waiters = attachWaitersByPane.get(paneId);
	if (!waiters) return;
	attachWaitersByPane.delete(paneId);
	for (const waiter of waiters) {
		waiter();
	}
}

function waitForAttachClear(paneId: string, waiter: () => void): () => void {
	if (!attachInFlightByPane.has(paneId)) {
		waiter();
		return () => {};
	}

	let waiters = attachWaitersByPane.get(paneId);
	if (!waiters) {
		waiters = new Set();
		attachWaitersByPane.set(paneId, waiters);
	}
	waiters.add(waiter);

	return () => {
		const current = attachWaitersByPane.get(paneId);
		if (!current) return;
		current.delete(waiter);
		if (current.size === 0) {
			attachWaitersByPane.delete(paneId);
		}
	};
}

export interface UseTerminalLifecycleOptions {
	paneId: string;
	tabIdRef: MutableRefObject<string>;
	workspaceId: string;
	terminalRef: RefObject<HTMLDivElement | null>;
	adapterRef: MutableRefObject<ResttyAdapter | null>;
	searchShimRef: MutableRefObject<SearchShim | null>;
	isExitedRef: MutableRefObject<boolean>;
	wasKilledByUserRef: MutableRefObject<boolean>;
	commandBufferRef: MutableRefObject<string>;
	isFocusedRef: MutableRefObject<boolean>;
	isRestoredModeRef: MutableRefObject<boolean>;
	connectionErrorRef: MutableRefObject<string | null>;
	initialThemeRef: MutableRefObject<GhosttyTheme | null>;
	workspaceCwdRef: MutableRefObject<string | null>;
	handleFileLinkClickRef: MutableRefObject<
		(path: string, line?: number, column?: number) => void
	>;
	paneInitialCommandsRef: MutableRefObject<string[] | undefined>;
	paneInitialCwdRef: MutableRefObject<string | undefined>;
	clearPaneInitialDataRef: MutableRefObject<(paneId: string) => void>;
	setConnectionError: (error: string | null) => void;
	setExitStatus: (status: "killed" | "exited" | null) => void;
	setIsRestoredMode: (value: boolean) => void;
	setRestoredCwd: (cwd: string | null) => void;
	createOrAttachRef: MutableRefObject<CreateOrAttachMutate>;
	writeRef: MutableRefObject<TerminalWriteMutate>;
	resizeRef: MutableRefObject<TerminalResizeMutate>;
	detachRef: MutableRefObject<TerminalDetachMutate>;
	clearScrollbackRef: MutableRefObject<TerminalClearScrollbackMutate>;
	isStreamReadyRef: MutableRefObject<boolean>;
	didFirstRenderRef: MutableRefObject<boolean>;
	pendingInitialStateRef: MutableRefObject<CreateOrAttachResult | null>;
	maybeApplyInitialState: () => void;
	flushPendingEvents: () => void;
	resetModes: () => void;
	isAlternateScreenRef: MutableRefObject<boolean>;
	isBracketedPasteRef: MutableRefObject<boolean>;
	setPaneNameRef: MutableRefObject<(paneId: string, name: string) => void>;
	renameUnnamedWorkspaceRef: MutableRefObject<(title: string) => void>;
	handleTerminalFocusRef: MutableRefObject<() => void>;
	registerClearCallbackRef: MutableRefObject<RegisterCallback>;
	unregisterClearCallbackRef: MutableRefObject<UnregisterCallback>;
	registerScrollToBottomCallbackRef: MutableRefObject<RegisterCallback>;
	unregisterScrollToBottomCallbackRef: MutableRefObject<UnregisterCallback>;
	registerGetSelectionCallbackRef: MutableRefObject<
		(paneId: string, callback: () => string) => void
	>;
	unregisterGetSelectionCallbackRef: MutableRefObject<UnregisterCallback>;
	registerPasteCallbackRef: MutableRefObject<
		(paneId: string, callback: (text: string) => void) => void
	>;
	unregisterPasteCallbackRef: MutableRefObject<UnregisterCallback>;
}

export interface UseTerminalLifecycleReturn {
	adapterInstance: ResttyAdapter | null;
	restartTerminal: () => void;
}

export function useTerminalLifecycle({
	paneId,
	tabIdRef,
	workspaceId,
	terminalRef,
	adapterRef,
	searchShimRef,
	isExitedRef,
	wasKilledByUserRef,
	commandBufferRef,
	isFocusedRef,
	isRestoredModeRef,
	connectionErrorRef,
	initialThemeRef,
	workspaceCwdRef,
	handleFileLinkClickRef,
	paneInitialCommandsRef,
	paneInitialCwdRef,
	clearPaneInitialDataRef,
	setConnectionError,
	setExitStatus,
	setIsRestoredMode,
	setRestoredCwd,
	createOrAttachRef,
	writeRef,
	resizeRef,
	detachRef,
	clearScrollbackRef,
	isStreamReadyRef,
	didFirstRenderRef,
	pendingInitialStateRef,
	maybeApplyInitialState,
	flushPendingEvents,
	resetModes,
	isAlternateScreenRef,
	isBracketedPasteRef,
	setPaneNameRef,
	renameUnnamedWorkspaceRef,
	handleTerminalFocusRef,
	registerClearCallbackRef,
	unregisterClearCallbackRef,
	registerScrollToBottomCallbackRef,
	unregisterScrollToBottomCallbackRef,
	registerGetSelectionCallbackRef,
	unregisterGetSelectionCallbackRef,
	registerPasteCallbackRef,
	unregisterPasteCallbackRef,
}: UseTerminalLifecycleOptions): UseTerminalLifecycleReturn {
	const [adapterInstance, setAdapterInstance] = useState<ResttyAdapter | null>(
		null,
	);
	const restartTerminalRef = useRef<() => void>(() => {});
	const restartTerminal = useCallback(() => restartTerminalRef.current(), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refs used intentionally
	useEffect(() => {
		const container = terminalRef.current;
		if (!container) return;

		if (DEBUG_TERMINAL) {
			console.log(`[Terminal] Mount: ${paneId}`);
		}

		// Cancel pending detach from previous unmount
		const pendingDetach = pendingDetaches.get(paneId);
		if (pendingDetach) {
			clearTimeout(pendingDetach);
			pendingDetaches.delete(paneId);
		}

		let isUnmounted = false;
		let attachCanceled = false;
		let attachSequence = 0;
		let activeAttachId = 0;
		let cancelAttachWait: (() => void) | null = null;

		// Create transport for tRPC IPC
		const transport = new TrpcPtyTransport({
			paneId,
			writeRef,
			resizeRef,
		});

		// Convert initial ITheme-style theme to GhosttyTheme if available
		const initialTheme = initialThemeRef.current ?? undefined;

		const {
			adapter,
			linkDetector,
			cleanup: cleanupRestty,
		} = createResttyInstance(container, transport, {
			cwd: workspaceCwdRef.current ?? undefined,
			initialTheme: initialTheme ?? null,
			onFileLinkClick: (path, line, column) =>
				handleFileLinkClickRef.current(path, line, column),
		});

		const scheduleScrollToBottom = () => {
			requestAnimationFrame(() => {
				if (isUnmounted || adapterRef.current !== adapter) return;
				scrollToBottom(adapter);
			});
		};

		adapterRef.current = adapter;
		isExitedRef.current = false;
		setAdapterInstance(adapter);
		isStreamReadyRef.current = false;
		didFirstRenderRef.current = false;
		pendingInitialStateRef.current = null;

		// Create SearchShim for terminal search
		// Note: RenderState is not exposed in restty's public API (v0.1.34).
		// Search will be functional when restty adds a text extraction API.
		const searchShim = new SearchShim(() => null);
		searchShimRef.current = searchShim;

		if (isFocusedRef.current) {
			adapter.focus();
		}

		// Use requestAnimationFrame as "first render" signal
		// restty renders immediately via WebGPU, so this fires on next frame
		let firstRenderFallback: ReturnType<typeof setTimeout> | null = null;

		requestAnimationFrame(() => {
			if (isUnmounted || didFirstRenderRef.current) return;
			if (firstRenderFallback) {
				clearTimeout(firstRenderFallback);
				firstRenderFallback = null;
			}
			didFirstRenderRef.current = true;
			maybeApplyInitialState();
		});

		firstRenderFallback = setTimeout(() => {
			if (isUnmounted || didFirstRenderRef.current) return;
			didFirstRenderRef.current = true;
			maybeApplyInitialState();
		}, FIRST_RENDER_RESTORE_FALLBACK_MS);

		const restartTerminalSession = () => {
			isExitedRef.current = false;
			isStreamReadyRef.current = false;
			wasKilledByUserRef.current = false;
			setExitStatus(null);
			resetModes();
			adapter.clear();
			createOrAttachRef.current(
				{
					paneId,
					tabId: tabIdRef.current,
					workspaceId,
					cols: adapter.cols,
					rows: adapter.rows,
					allowKilled: true,
				},
				{
					onSuccess: (result) => {
						pendingInitialStateRef.current = result;
						maybeApplyInitialState();
					},
					onError: (error) => {
						console.error("[Terminal] Failed to restart:", error);
						setConnectionError(error.message || "Failed to restart terminal");
						isStreamReadyRef.current = true;
						flushPendingEvents();
					},
				},
			);
		};

		restartTerminalRef.current = restartTerminalSession;

		const handleTerminalInput = (data: string) => {
			if (isRestoredModeRef.current || connectionErrorRef.current) return;
			if (isExitedRef.current) {
				if (!isFocusedRef.current || wasKilledByUserRef.current) return;
				restartTerminalSession();
				return;
			}
			writeRef.current({ paneId, data });
		};

		const handleKeyPress = (data: string) => {
			if (isRestoredModeRef.current || connectionErrorRef.current) return;
			// Infer key from the data sent — single-char data with no modifiers is a character
			if (data === "\r") {
				// Enter
				if (!isAlternateScreenRef.current) {
					const title = sanitizeForTitle(commandBufferRef.current);
					if (title) {
						setPaneNameRef.current(paneId, title);
					}
				}
				commandBufferRef.current = "";
			} else if (data === "\x7f") {
				// Backspace
				commandBufferRef.current = commandBufferRef.current.slice(0, -1);
			} else if (data === "\x03") {
				// Ctrl+C
				commandBufferRef.current = "";
				const currentPane = useTabsStore.getState().panes[paneId];
				if (
					currentPane?.status === "working" ||
					currentPane?.status === "permission"
				) {
					useTabsStore.getState().setPaneStatus(paneId, "idle");
				}
			} else if (data === "\x1b") {
				// Escape
				const currentPane = useTabsStore.getState().panes[paneId];
				if (
					currentPane?.status === "working" ||
					currentPane?.status === "permission"
				) {
					useTabsStore.getState().setPaneStatus(paneId, "idle");
				}
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				// Printable character
				commandBufferRef.current += data;
			}
		};

		const initialCommands = paneInitialCommandsRef.current;
		const initialCwd = paneInitialCwdRef.current;

		const cancelInitialAttach = scheduleTerminalAttach({
			paneId,
			priority: isFocusedRef.current ? 0 : 1,
			run: (done) => {
				const startAttach = () => {
					if (attachCanceled) return;
					if (attachInFlightByPane.has(paneId)) {
						cancelAttachWait = waitForAttachClear(paneId, () => {
							if (attachCanceled || isUnmounted) return;
							startAttach();
						});
						return;
					}

					activeAttachId = ++attachSequence;
					const attachId = activeAttachId;
					const isAttachActive = () =>
						!isUnmounted && !attachCanceled && attachId === activeAttachId;

					markAttachInFlight(paneId, attachId);

					const finishAttach = () => {
						clearAttachInFlight(paneId, attachId);
						done();
					};

					if (DEBUG_TERMINAL) {
						console.log(`[Terminal] createOrAttach start: ${paneId}`);
					}
					createOrAttachRef.current(
						{
							paneId,
							tabId: tabIdRef.current,
							workspaceId,
							cols: adapter.cols,
							rows: adapter.rows,
							initialCommands,
							cwd: initialCwd,
						},
						{
							onSuccess: (result) => {
								if (!isAttachActive()) return;
								setConnectionError(null);
								if (initialCommands || initialCwd) {
									clearPaneInitialDataRef.current(paneId);
								}

								const storedColdRestore = coldRestoreState.get(paneId);
								if (storedColdRestore?.isRestored) {
									setIsRestoredMode(true);
									setRestoredCwd(storedColdRestore.cwd);
									if (storedColdRestore.scrollback && adapter) {
										adapter.write(
											storedColdRestore.scrollback,
											scheduleScrollToBottom,
										);
									}
									didFirstRenderRef.current = true;
									return;
								}

								if (result.isColdRestore) {
									const scrollback =
										result.snapshot?.snapshotAnsi ?? result.scrollback;
									coldRestoreState.set(paneId, {
										isRestored: true,
										cwd: result.previousCwd || null,
										scrollback,
									});
									setIsRestoredMode(true);
									setRestoredCwd(result.previousCwd || null);
									if (scrollback && adapter) {
										adapter.write(scrollback, scheduleScrollToBottom);
									}
									didFirstRenderRef.current = true;
									return;
								}

								pendingInitialStateRef.current = result;
								maybeApplyInitialState();
							},
							onError: (error) => {
								if (!isAttachActive()) return;
								if (error.message?.includes("TERMINAL_SESSION_KILLED")) {
									wasKilledByUserRef.current = true;
									isExitedRef.current = true;
									isStreamReadyRef.current = false;
									setExitStatus("killed");
									setConnectionError(null);
									return;
								}
								console.error("[Terminal] Failed to create/attach:", error);
								setConnectionError(
									error.message || "Failed to connect to terminal",
								);
								isStreamReadyRef.current = true;
								flushPendingEvents();
							},
							onSettled: () => finishAttach(),
						},
					);
				};

				startAttach();
				return;
			},
		});

		// Register input and event listeners
		const inputDisposable = adapter.onData((data) => {
			handleTerminalInput(data);
			handleKeyPress(data);
		});

		const titleDisposable = adapter.onTitleChange((title) => {
			if (title) {
				setPaneNameRef.current(paneId, title);
				renameUnnamedWorkspaceRef.current(title);
			}
		});

		const handleClear = () => {
			adapter.clearScreen();
			clearScrollbackRef.current({ paneId });
		};

		const handleScrollToBottom = () => scrollToBottom(adapter);

		const handleWrite = (data: string) => {
			if (isExitedRef.current) return;
			writeRef.current({ paneId, data });
		};

		// Setup keyboard handler via restty's beforeInput interceptor
		const keyboardHandler = createKeyboardHandler({
			onShiftEnter: () => handleWrite("\x1b\r"),
			onClear: handleClear,
			onWrite: handleWrite,
		});

		// Attach keyboard handler to container
		const handleKeyDown = (event: KeyboardEvent) => {
			const allowed = keyboardHandler(event);
			if (!allowed) {
				// Key was consumed by our handler
			}
		};
		container.addEventListener("keydown", handleKeyDown);

		// Click-to-move cursor
		const cleanupClickToMove = setupClickToMoveCursor({
			container,
			getCellDimensions: () => adapter.getCellDimensions(),
			getCursorPosition: () => adapter.getCursorPosition(),
			sendInput: (data) => adapter.sendInput(data),
			isAlternateScreen: () => isAlternateScreenRef.current,
		});

		registerClearCallbackRef.current(paneId, handleClear);
		registerScrollToBottomCallbackRef.current(paneId, handleScrollToBottom);

		const handleGetSelection = () => {
			// restty handles selection internally via WebGPU canvas
			// Selection text extraction isn't directly exposed yet
			// For now, return empty — copy to clipboard works via adapter.copySelectionToClipboard()
			return "";
		};

		const handlePaste = (text: string) => {
			if (isExitedRef.current) return;
			// Wrap with bracketed paste sequences if enabled
			const wrappedText = isBracketedPasteRef.current
				? `\x1b[200~${text}\x1b[201~`
				: text;
			handleWrite(wrappedText);
		};

		registerGetSelectionCallbackRef.current(paneId, handleGetSelection);
		registerPasteCallbackRef.current(paneId, handlePaste);

		const cleanupFocus = setupFocusListener(container, () =>
			handleTerminalFocusRef.current(),
		);

		// Resize handler — restty handles fit natively via autoResize,
		// but we need to notify the PTY daemon of size changes
		const resizeObserver = new ResizeObserver(() => {
			if (isUnmounted || adapterRef.current !== adapter) return;
			// Let restty update its internal size first
			adapter.updateSize();
			// Then notify the PTY daemon
			resizeRef.current({ paneId, cols: adapter.cols, rows: adapter.rows });
		});
		resizeObserver.observe(container);

		const cleanupPaste = setupPasteHandler(container, {
			onPaste: (text) => {
				commandBufferRef.current += text;
			},
			onWrite: handleWrite,
			isBracketedPasteEnabled: () => isBracketedPasteRef.current,
		});

		const handleVisibilityChange = () => {
			if (document.hidden || isUnmounted) return;
			const wasAtBottom = adapter.isAtBottom();
			const prevCols = adapter.cols;
			const prevRows = adapter.rows;
			adapter.updateSize(true);
			if (adapter.cols !== prevCols || adapter.rows !== prevRows) {
				resizeRef.current({ paneId, cols: adapter.cols, rows: adapter.rows });
			}
			if (wasAtBottom) {
				requestAnimationFrame(() => {
					if (isUnmounted || adapterRef.current !== adapter) return;
					scrollToBottom(adapter);
				});
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		const isPaneDestroyedInStore = () =>
			isPaneDestroyed(useTabsStore.getState().panes, paneId);

		return () => {
			if (DEBUG_TERMINAL) {
				console.log(`[Terminal] Unmount: ${paneId}`);
			}
			cancelInitialAttach();
			isUnmounted = true;
			attachCanceled = true;
			const cleanupAttachId = activeAttachId || undefined;
			activeAttachId = 0;
			if (cancelAttachWait) {
				cancelAttachWait();
				cancelAttachWait = null;
			}
			clearAttachInFlight(paneId, cleanupAttachId);
			if (firstRenderFallback) clearTimeout(firstRenderFallback);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			container.removeEventListener("keydown", handleKeyDown);
			inputDisposable.dispose();
			titleDisposable.dispose();
			cleanupClickToMove();
			cleanupFocus?.();
			cleanupPaste();
			cleanupRestty();
			resizeObserver.disconnect();
			unregisterClearCallbackRef.current(paneId);
			unregisterScrollToBottomCallbackRef.current(paneId);
			unregisterGetSelectionCallbackRef.current(paneId);
			unregisterPasteCallbackRef.current(paneId);

			if (isPaneDestroyedInStore()) {
				// Pane was explicitly destroyed, so kill the session.
				killTerminalForPane(paneId);
				coldRestoreState.delete(paneId);
				pendingDetaches.delete(paneId);
			} else {
				const detachTimeout = setTimeout(() => {
					detachRef.current({ paneId });
					pendingDetaches.delete(paneId);
					coldRestoreState.delete(paneId);
				}, 50);
				pendingDetaches.set(paneId, detachTimeout);
			}

			isStreamReadyRef.current = false;
			didFirstRenderRef.current = false;
			pendingInitialStateRef.current = null;
			resetModes();

			setTimeout(() => adapter.dispose(), 0);

			adapterRef.current = null;
			searchShimRef.current = null;
			setAdapterInstance(null);
		};
	}, [
		paneId,
		workspaceId,
		maybeApplyInitialState,
		flushPendingEvents,
		setConnectionError,
		resetModes,
		setIsRestoredMode,
		setRestoredCwd,
	]);

	return { adapterInstance, restartTerminal };
}
