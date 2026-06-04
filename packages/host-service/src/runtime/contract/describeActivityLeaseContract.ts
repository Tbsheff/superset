import { describe, expect, test } from "bun:test";
import { descriptorSupportsActivity } from "../descriptors/index.ts";
import { type ContractContext, defaultWorkspacePlan } from "./types.ts";

/**
 * Exercises ActivityLease.heartbeat()/release() and the HeartbeatResult union,
 * INCLUDING the hard-cap path:
 *   - refresh-activity ⇒ heartbeat() returns { ok: true }.
 *   - hard-cap ⇒ after the cap elapses (driven via ctx.advanceClock), heartbeat()
 *     returns { ok: false, reason: "must-rehydrate" } and never fakes success.
 * release() is idempotent.
 */
export function describeActivityLeaseContract(ctx: ContractContext): void {
	const plan = () =>
		ctx.workspacePlan?.() ?? defaultWorkspacePlan("c-activity");

	describe("activity-lease contract", () => {
		test("heartbeat result matches the descriptor's activity strategy", async () => {
			const adapter = await ctx.makeAdapter();
			const refreshes = descriptorSupportsActivity(
				adapter.descriptor,
				"refresh-activity",
			);
			const hardCap = adapter.descriptor.activity.find(
				(a) => a.kind === "hard-cap",
			);

			const handle = await adapter.createInstance(plan());
			const lease = handle.activityLease();

			const first = await lease.heartbeat();
			if (refreshes) {
				expect(first.ok).toBe(true);
			}

			if (hardCap && hardCap.kind === "hard-cap") {
				// Before the cap, the lease must report ok (it is not yet stale).
				expect(first.ok).toBe(true);
				if (ctx.advanceClock) {
					ctx.advanceClock(hardCap.maxMs + 1);
					const afterCap = await lease.heartbeat();
					expect(afterCap.ok).toBe(false);
					if (afterCap.ok === false) {
						expect(afterCap.reason).toBe("must-rehydrate");
					}
				}
			}

			await lease.release();
			await lease.release(); // idempotent
		});
	});
}
