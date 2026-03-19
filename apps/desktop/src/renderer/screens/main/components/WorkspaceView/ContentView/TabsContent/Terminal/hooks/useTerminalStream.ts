import { toast } from "@superset/ui/sonner";
import { useCallback, useRef } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import { DEBUG_TERMINAL } from "../config";
import type { ResttyAdapter } from "../restty/ResttyAdapter";
import type { TerminalExitReason, TerminalStreamEvent } from "../types";

export interface UseTerminalStreamOptions {
	paneId: string;
	adapterRef: React.MutableRefObject<ResttyAdapter | null>;
	isStreamReadyRef: React.MutableRefObject<boolean>;
	isExitedRef: React.MutableRefObject<boolean>;
	wasKilledByUserRef: React.MutableRefObject<boolean>;
	pendingEventsRef: React.MutableRefObject<TerminalStreamEvent[]>;
	setExitStatus: (status: "killed" | "exited" | null) => void;
	setConnectionError: (error: string | null) => void;
	updateModesFromData: (data: string) => void;
	updateCwdFromData: (data: string) => void;
}

export interface UseTerminalStreamReturn {
	handleTerminalExit: (
		exitCode: number,
		adapter: ResttyAdapter,
		reason?: TerminalExitReason,
	) => void;
	handleStreamError: (
		event: Extract<TerminalStreamEvent, { type: "error" }>,
		adapter: ResttyAdapter,
	) => void;
	handleStreamData: (event: TerminalStreamEvent) => void;
}

/**
 * Hook to handle terminal stream events (data, exit, disconnect, error).
 */
export function useTerminalStream({
	paneId,
	adapterRef,
	isStreamReadyRef,
	isExitedRef,
	wasKilledByUserRef,
	pendingEventsRef,
	setExitStatus,
	setConnectionError,
	updateModesFromData,
	updateCwdFromData,
}: UseTerminalStreamOptions): UseTerminalStreamReturn {
	const setPaneStatus = useTabsStore((s) => s.setPaneStatus);
	const firstStreamDataReceivedRef = useRef(false);

	// Refs to use latest values in callbacks
	const updateModesRef = useRef(updateModesFromData);
	updateModesRef.current = updateModesFromData;
	const updateCwdRef = useRef(updateCwdFromData);
	updateCwdRef.current = updateCwdFromData;

	const handleTerminalExit = useCallback(
		(exitCode: number, adapter: ResttyAdapter, reason?: TerminalExitReason) => {
			isExitedRef.current = true;
			isStreamReadyRef.current = false;

			const wasKilledByUser = reason === "killed";
			wasKilledByUserRef.current = wasKilledByUser;
			setExitStatus(wasKilledByUser ? "killed" : "exited");

			if (wasKilledByUser) {
				adapter.writeln("\r\n\r\n[Session killed]");
				adapter.writeln("[Restart to start a new session]");
			} else {
				adapter.writeln(`\r\n\r\n[Process exited with code ${exitCode}]`);
				adapter.writeln("[Press any key to restart]");
			}

			// Clear transient pane status on terminal exit
			const currentPane = useTabsStore.getState().panes[paneId];
			if (
				currentPane?.status === "working" ||
				currentPane?.status === "permission"
			) {
				setPaneStatus(paneId, "idle");
			}
		},
		[
			paneId,
			isExitedRef,
			isStreamReadyRef,
			wasKilledByUserRef,
			setExitStatus,
			setPaneStatus,
		],
	);

	const handleStreamError = useCallback(
		(
			event: Extract<TerminalStreamEvent, { type: "error" }>,
			adapter: ResttyAdapter,
		) => {
			const message = event.code
				? `${event.code}: ${event.error}`
				: event.error;
			console.warn("[Terminal] stream error:", message);

			if (
				event.code === "WRITE_FAILED" &&
				event.error?.includes("Session not found")
			) {
				setConnectionError("Session lost - click to reconnect");
				return;
			}

			if (
				event.code === "WRITE_FAILED" &&
				event.error?.includes("PTY not spawned")
			) {
				adapter.writeln(`\r\n[Terminal] ${message}`);
				return;
			}

			if (event.code === "WRITE_QUEUE_FULL") {
				// Backpressure signal — already throttled at source, just log quietly
				console.warn("[Terminal] write queue full, some input was dropped");
				return;
			}

			toast.error("Terminal error", { description: message });

			if (event.code === "WRITE_FAILED") {
				adapter.writeln(`\r\n[Terminal] ${message}`);
			} else {
				setConnectionError(message);
			}
		},
		[setConnectionError],
	);

	const handleStreamData = useCallback(
		(event: TerminalStreamEvent) => {
			const adapter = adapterRef.current;

			// Queue ALL events until terminal is ready, preserving order
			// flushPendingEvents will process them in sequence after restore
			if (!adapter || !isStreamReadyRef.current) {
				if (DEBUG_TERMINAL && event.type === "data") {
					console.log(
						`[Terminal] Queuing event (not ready): ${paneId}, type=${event.type}, bytes=${event.data.length}`,
					);
				}
				pendingEventsRef.current.push(event);
				return;
			}

			// Process events when stream is ready
			if (event.type === "data") {
				if (DEBUG_TERMINAL && !firstStreamDataReceivedRef.current) {
					firstStreamDataReceivedRef.current = true;
					console.log(
						`[Terminal] First stream data received: ${paneId}, ${event.data.length} bytes`,
					);
				}
				updateModesRef.current(event.data);
				adapter.write(event.data);
				updateCwdRef.current(event.data);
			} else if (event.type === "exit") {
				handleTerminalExit(event.exitCode, adapter, event.reason);
			} else if (event.type === "disconnect") {
				setConnectionError(
					event.reason || "Connection to terminal daemon lost",
				);
			} else if (event.type === "error") {
				handleStreamError(event, adapter);
			}
		},
		[
			paneId,
			adapterRef,
			isStreamReadyRef,
			pendingEventsRef,
			handleTerminalExit,
			handleStreamError,
			setConnectionError,
		],
	);

	return {
		handleTerminalExit,
		handleStreamError,
		handleStreamData,
	};
}
