export type HeartbeatResult =
	| { ok: true }
	| { ok: false; reason: "must-rehydrate" | "expired" };

/**
 * One normalized verb. Adapter maps heartbeat() to refreshActivity /
 * extendTimeout / renewActivityTimeout / keepAlive internally. Modal's hard
 * cap returns { ok: false, reason: "must-rehydrate" } instead of faking a
 * heartbeat.
 */
export interface ActivityLease {
	heartbeat(): Promise<HeartbeatResult>;
	release(): Promise<void>;
}
