import type { ActivityLease, HeartbeatResult } from "../../seam/index.ts";
import type { Sandbox } from "./types.ts";

/** The slice of `Sandbox` the lease drives — only `refreshActivity`. */
export type RefreshableSandbox = Pick<Sandbox, "refreshActivity">;

/**
 * In-memory `refresh-activity` lease for a Daytona sandbox.
 *
 * Daytona auto-stops a sandbox after its idle interval; `refreshActivity()`
 * resets that idle timer WITHOUT changing state. Critically, preview-URL traffic
 * does NOT count as activity (SDK docs: "Interactions using Sandbox Previews are
 * not included"), so this timer is the ONLY thing keeping a live session alive.
 *
 * `refreshData()` is deliberately never called — it only re-fetches state and
 * does not reset the idle timer. State lives in memory; there is no
 * `runtime_activity_leases` table in v1. The lease is started when a session
 * attaches and `release()`d on detach/destroy.
 */
export class DaytonaActivityLease implements ActivityLease {
	private timer: ReturnType<typeof setInterval> | null = null;
	private released = false;

	constructor(
		private readonly sandbox: RefreshableSandbox,
		private readonly intervalMs = 60_000,
	) {}

	/** Begin the keep-alive timer. Idempotent: a second start is a no-op. */
	start(): void {
		if (this.timer || this.released) return;
		this.timer = setInterval(() => {
			void this.heartbeat();
		}, this.intervalMs);
		// Do not keep the host process alive solely for the heartbeat.
		this.timer.unref?.();
	}

	async heartbeat(): Promise<HeartbeatResult> {
		if (this.released) return { ok: false, reason: "expired" };
		try {
			await this.sandbox.refreshActivity();
			return { ok: true };
		} catch {
			return { ok: false, reason: "expired" };
		}
	}

	async release(): Promise<void> {
		this.released = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
