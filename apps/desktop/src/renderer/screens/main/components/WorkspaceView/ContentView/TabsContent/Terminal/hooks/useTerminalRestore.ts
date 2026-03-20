import { useCallback, useRef } from "react";
import { DEBUG_TERMINAL } from "../config";
import { scheduleTerminalRestore } from "../restore-scheduler";
import type { ResttyAdapter } from "../restty/ResttyAdapter";
import type {
	CreateOrAttachResult,
	TerminalExitReason,
	TerminalStreamEvent,
} from "../types";
import { scrollToBottom } from "../utils";

export interface UseTerminalRestoreOptions {
	paneId: string;
	adapterRef: React.MutableRefObject<ResttyAdapter | null>;
	pendingEventsRef: React.MutableRefObject<TerminalStreamEvent[]>;
	isAlternateScreenRef: React.MutableRefObject<boolean>;
	isBracketedPasteRef: React.MutableRefObject<boolean>;
	modeScanBufferRef: React.MutableRefObject<string>;
	updateCwdFromData: (data: string) => void;
	updateModesFromData: (data: string) => void;
	onExitEvent: (
		exitCode: number,
		adapter: ResttyAdapter,
		reason?: TerminalExitReason,
	) => void;
	onErrorEvent: (
		event: Extract<TerminalStreamEvent, { type: "error" }>,
		adapter: ResttyAdapter,
	) => void;
	onDisconnectEvent: (reason: string | undefined) => void;
}

export interface UseTerminalRestoreReturn {
	isStreamReadyRef: React.MutableRefObject<boolean>;
	didFirstRenderRef: React.MutableRefObject<boolean>;
	pendingInitialStateRef: React.MutableRefObject<CreateOrAttachResult | null>;
	restoreSequenceRef: React.MutableRefObject<number>;
	maybeApplyInitialState: () => void;
	flushPendingEvents: () => void;
}

/**
 * Hook to manage terminal state restoration from snapshots.
 *
 * Handles:
 * - Applying initial state from createOrAttach response
 * - Restoring terminal modes (alternate screen, bracketed paste)
 * - Managing stream readiness gating
 * - Flushing pending events after restoration
 */
export function useTerminalRestore({
	paneId,
	adapterRef,
	pendingEventsRef,
	isAlternateScreenRef,
	isBracketedPasteRef,
	modeScanBufferRef,
	updateCwdFromData,
	updateModesFromData,
	onExitEvent,
	onErrorEvent,
	onDisconnectEvent,
}: UseTerminalRestoreOptions): UseTerminalRestoreReturn {
	// Gate streaming until initial state restoration is applied
	const isStreamReadyRef = useRef(false);
	// Gate restoration until restty has rendered at least once
	const didFirstRenderRef = useRef(false);
	const pendingInitialStateRef = useRef<CreateOrAttachResult | null>(null);
	const restoreSequenceRef = useRef(0);

	// Refs to use latest values in callbacks
	const updateCwdRef = useRef(updateCwdFromData);
	updateCwdRef.current = updateCwdFromData;
	const updateModesRef = useRef(updateModesFromData);
	updateModesRef.current = updateModesFromData;
	const onExitEventRef = useRef(onExitEvent);
	onExitEventRef.current = onExitEvent;
	const onErrorEventRef = useRef(onErrorEvent);
	onErrorEventRef.current = onErrorEvent;
	const onDisconnectEventRef = useRef(onDisconnectEvent);
	onDisconnectEventRef.current = onDisconnectEvent;

	const flushPendingEvents = useCallback(() => {
		const adapter = adapterRef.current;
		if (!adapter) return;
		if (pendingEventsRef.current.length === 0) return;

		const events = pendingEventsRef.current.splice(
			0,
			pendingEventsRef.current.length,
		);
		let totalBytes = 0;
		for (const event of events) {
			if (event.type === "data") {
				totalBytes += event.data.length;
			}
		}
		if (totalBytes > 0) {
			console.log(
				`[Terminal] Flushing ${events.length} pending events (${(totalBytes / 1024).toFixed(0)}KB) for ${paneId}`,
			);
		}
		for (const event of events) {
			if (event.type === "data") {
				updateModesRef.current(event.data);
				adapter.write(event.data);
				updateCwdRef.current(event.data);
			} else if (event.type === "exit") {
				onExitEventRef.current(event.exitCode, adapter, event.reason);
			} else if (event.type === "error") {
				onErrorEventRef.current(event, adapter);
			} else if (event.type === "disconnect") {
				onDisconnectEventRef.current(event.reason);
			}
		}
	}, [adapterRef, pendingEventsRef]);

	const maybeApplyInitialState = useCallback(() => {
		if (!didFirstRenderRef.current) return;
		const result = pendingInitialStateRef.current;
		if (!result) return;

		const adapter = adapterRef.current;
		if (!adapter) return;

		// Clear before applying to prevent double-apply on concurrent triggers
		pendingInitialStateRef.current = null;
		++restoreSequenceRef.current;
		const restoreSequence = restoreSequenceRef.current;
		try {
			const scheduleFitAndScroll = () => {
				requestAnimationFrame(() => {
					if (adapterRef.current !== adapter) return;
					if (restoreSequenceRef.current !== restoreSequence) return;
					// restty handles fit natively via autoResize
					adapter.updateSize(true);
					scrollToBottom(adapter);
				});
			};

			// Canonical initial content: prefer snapshot (daemon mode) over scrollback
			// Cap at 512KB to prevent renderer OOM from oversized stored snapshots
			const MAX_RESTORE_BYTES = 512 * 1024;
			let initialAnsi = result.snapshot?.snapshotAnsi ?? result.scrollback;
			console.log(
				`[Terminal] Restore payload: ${initialAnsi ? `${(initialAnsi.length / 1024).toFixed(0)}KB` : "none"}, rehydrate: ${result.snapshot?.rehydrateSequences ? `${(result.snapshot.rehydrateSequences.length / 1024).toFixed(0)}KB` : "none"}, isNew=${result.isNew} for ${paneId}`,
			);
			if (initialAnsi && initialAnsi.length > MAX_RESTORE_BYTES) {
				console.warn(
					`[Terminal] Truncating restore payload: ${(initialAnsi.length / 1024).toFixed(0)}KB → ${MAX_RESTORE_BYTES / 1024}KB for ${paneId}`,
				);
				initialAnsi = initialAnsi.slice(-MAX_RESTORE_BYTES);
			}

			// Track alternate screen mode from snapshot
			isAlternateScreenRef.current = !!result.snapshot?.modes.alternateScreen;
			isBracketedPasteRef.current = !!result.snapshot?.modes.bracketedPaste;
			modeScanBufferRef.current = "";

			// Fallback: parse initialAnsi for escape sequences when snapshot.modes is unavailable
			if (initialAnsi && result.snapshot?.modes === undefined) {
				const enterAltIndex = Math.max(
					initialAnsi.lastIndexOf("\x1b[?1049h"),
					initialAnsi.lastIndexOf("\x1b[?47h"),
				);
				const exitAltIndex = Math.max(
					initialAnsi.lastIndexOf("\x1b[?1049l"),
					initialAnsi.lastIndexOf("\x1b[?47l"),
				);
				if (enterAltIndex !== -1 || exitAltIndex !== -1) {
					isAlternateScreenRef.current = enterAltIndex > exitAltIndex;
				}

				const bracketEnableIndex = initialAnsi.lastIndexOf("\x1b[?2004h");
				const bracketDisableIndex = initialAnsi.lastIndexOf("\x1b[?2004l");
				if (bracketEnableIndex !== -1 || bracketDisableIndex !== -1) {
					isBracketedPasteRef.current =
						bracketEnableIndex > bracketDisableIndex;
				}
			}

			const isAltScreenReattach =
				!result.isNew && result.snapshot?.modes.alternateScreen;

			// Schedule restore writes through the global restore scheduler
			// so only one terminal writes its multi-MB payload at a time.
			scheduleTerminalRestore({
				paneId,
				priority: 0,
				run: (restoreDone) => {
					// For alt-screen (TUI) sessions, enter alt-screen and trigger SIGWINCH
					if (isAltScreenReattach) {
						adapter.write("\x1b[?1049h", () => {
							if (result.snapshot?.rehydrateSequences) {
								const ESC = "\x1b";
								const filteredRehydrate = result.snapshot.rehydrateSequences
									.split(`${ESC}[?1049h`)
									.join("")
									.split(`${ESC}[?47h`)
									.join("");
								if (filteredRehydrate) {
									adapter.write(filteredRehydrate);
								}
							}

							isStreamReadyRef.current = true;
							if (DEBUG_TERMINAL) {
								console.log(
									`[Terminal] isStreamReady=true (altScreen): ${paneId}, pendingEvents=${pendingEventsRef.current.length}`,
								);
							}
							flushPendingEvents();
							scheduleFitAndScroll();
							restoreDone();
						});
						return;
					}

					const rehydrateSequences = result.snapshot?.rehydrateSequences ?? "";

					const finalizeRestore = () => {
						isStreamReadyRef.current = true;
						scheduleFitAndScroll();
						if (DEBUG_TERMINAL) {
							console.log(
								`[Terminal] isStreamReady=true (finalizeRestore): ${paneId}, pendingEvents=${pendingEventsRef.current.length}`,
							);
						}
						flushPendingEvents();
						restoreDone();
					};

					const writeSnapshot = () => {
						if (!initialAnsi) {
							finalizeRestore();
							return;
						}
						adapter.write(initialAnsi, finalizeRestore);
					};

					if (rehydrateSequences) {
						adapter.write(rehydrateSequences, writeSnapshot);
					} else {
						writeSnapshot();
					}
				},
			});

			if (result.snapshot?.cwd) {
				updateCwdRef.current(result.snapshot.cwd);
			} else {
				updateCwdRef.current(initialAnsi);
			}
		} catch (error) {
			console.error("[Terminal] Restoration failed:", error);
			isStreamReadyRef.current = true;
			flushPendingEvents();
		}
	}, [
		paneId,
		adapterRef,
		pendingEventsRef,
		isAlternateScreenRef,
		isBracketedPasteRef,
		modeScanBufferRef,
		flushPendingEvents,
	]);

	return {
		isStreamReadyRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		restoreSequenceRef,
		maybeApplyInitialState,
		flushPendingEvents,
	};
}
