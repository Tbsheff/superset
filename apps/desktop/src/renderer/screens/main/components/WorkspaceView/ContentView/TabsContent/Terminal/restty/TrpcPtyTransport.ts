/**
 * PtyTransport implementation that bridges restty with Superset's tRPC IPC.
 *
 * Unlike WebSocket transport, we don't actually open a connection here —
 * the tRPC subscription (useTerminalStream) manages the data stream separately.
 * This transport just bridges I/O between restty and the tRPC mutations.
 */

import type { RefObject } from "react";
import type {
	PtyCallbacks,
	PtyConnectOptions,
	PtyTransport,
} from "restty/internal";

export interface TrpcPtyTransportOptions {
	paneId: string;
	writeRef: RefObject<
		((input: { paneId: string; data: string }) => void) | null
	>;
	resizeRef: RefObject<
		((input: { paneId: string; cols: number; rows: number }) => void) | null
	>;
}

export class TrpcPtyTransport implements PtyTransport {
	private readonly paneId: string;
	private readonly writeRef: TrpcPtyTransportOptions["writeRef"];
	private readonly resizeRef: TrpcPtyTransportOptions["resizeRef"];
	private callbacks: PtyCallbacks | null = null;
	private connected = false;

	constructor({ paneId, writeRef, resizeRef }: TrpcPtyTransportOptions) {
		this.paneId = paneId;
		this.writeRef = writeRef;
		this.resizeRef = resizeRef;
	}

	connect(options: PtyConnectOptions): void {
		this.callbacks = options.callbacks;
		this.connected = true;
		this.callbacks.onConnect?.();
	}

	disconnect(): void {
		this.connected = false;
		this.callbacks?.onDisconnect?.();
		this.callbacks = null;
	}

	sendInput(data: string): boolean {
		if (!this.connected) return false;
		this.writeRef.current?.({ paneId: this.paneId, data });
		return true;
	}

	resize(cols: number, rows: number): boolean {
		if (!this.connected) return false;
		this.resizeRef.current?.({ paneId: this.paneId, cols, rows });
		return true;
	}

	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Feed PTY output data into restty's WASM VT parser.
	 * Called by useTerminalStream when tRPC subscription delivers data.
	 */
	feedData(data: string): void {
		this.callbacks?.onData?.(data);
	}

	/**
	 * Notify restty of PTY exit.
	 */
	notifyExit(code: number): void {
		this.callbacks?.onExit?.(code);
	}

	/**
	 * Notify restty of PTY error.
	 */
	notifyError(message: string): void {
		this.callbacks?.onError?.(message);
	}

	destroy(): void {
		this.disconnect();
	}
}
