import { describe, expect, test } from "bun:test";
import {
	DaytonaActivityLease,
	type RefreshableSandbox,
} from "./DaytonaActivityLease.ts";

function makeSandbox(opts?: { throws?: boolean }): RefreshableSandbox & {
	refreshActivityCalls: number;
	refreshDataCalls: number;
} {
	const state = { refreshActivityCalls: 0, refreshDataCalls: 0 };
	return {
		...state,
		refreshActivity: async function (this: typeof state) {
			state.refreshActivityCalls += 1;
			if (opts?.throws) throw new Error("activity refresh failed");
		},
		get refreshActivityCalls() {
			return state.refreshActivityCalls;
		},
		get refreshDataCalls() {
			return state.refreshDataCalls;
		},
	} as never;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DaytonaActivityLease", () => {
	test("heartbeat calls refreshActivity and reports ok", async () => {
		const sandbox = makeSandbox();
		const lease = new DaytonaActivityLease(sandbox);
		const result = await lease.heartbeat();
		expect(result).toEqual({ ok: true });
		expect(sandbox.refreshActivityCalls).toBe(1);
	});

	test("the timer drives refreshActivity at the interval", async () => {
		const sandbox = makeSandbox();
		const lease = new DaytonaActivityLease(sandbox, 10);
		lease.start();
		await sleep(35);
		await lease.release();
		expect(sandbox.refreshActivityCalls).toBeGreaterThanOrEqual(2);
	});

	test("release stops further heartbeats and is idempotent", async () => {
		const sandbox = makeSandbox();
		const lease = new DaytonaActivityLease(sandbox, 10);
		lease.start();
		await sleep(15);
		await lease.release();
		const countAfterRelease = sandbox.refreshActivityCalls;
		await sleep(30);
		expect(sandbox.refreshActivityCalls).toBe(countAfterRelease);
		await lease.release(); // idempotent, no throw
		const post = await lease.heartbeat();
		expect(post).toEqual({ ok: false, reason: "expired" });
	});

	test("heartbeat returns expired when refreshActivity throws", async () => {
		const sandbox = makeSandbox({ throws: true });
		const lease = new DaytonaActivityLease(sandbox);
		const result = await lease.heartbeat();
		expect(result).toEqual({ ok: false, reason: "expired" });
	});

	test("never calls refreshData for keep-alive", async () => {
		const sandbox = makeSandbox();
		const lease = new DaytonaActivityLease(sandbox, 10);
		lease.start();
		await sleep(35);
		await lease.release();
		expect(sandbox.refreshDataCalls).toBe(0);
	});
});
