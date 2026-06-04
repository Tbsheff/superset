import type { ActivityLease } from "../../seam/index.ts";

/** A refresh-activity lease: heartbeats always succeed (Daytona/local shape). */
export function createRefreshActivityLease(): ActivityLease {
	let released = false;
	return {
		async heartbeat() {
			return released ? { ok: false, reason: "expired" } : { ok: true };
		},
		async release() {
			released = true;
		},
	};
}

/**
 * A hard-cap lease: heartbeats succeed until `maxMs` has elapsed on the injected
 * clock since the lease was created, then return must-rehydrate forever (it
 * never fakes a heartbeat past the cap — Modal's deferred shape).
 */
export function createHardCapLease(
	maxMs: number,
	now: () => number,
): ActivityLease {
	const startedAt = now();
	let released = false;
	return {
		async heartbeat() {
			if (released) return { ok: false, reason: "expired" };
			if (now() - startedAt > maxMs) {
				return { ok: false, reason: "must-rehydrate" };
			}
			return { ok: true };
		},
		async release() {
			released = true;
		},
	};
}
