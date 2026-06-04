import { describe, expect, test } from "bun:test";
import { DAYTONA_DESCRIPTOR } from "./daytona.ts";
import {
	descriptorSupportsActivity,
	descriptorSupportsEgress,
	descriptorSupportsExecution,
	descriptorSupportsRole,
} from "./index.ts";

describe("daytona descriptor", () => {
	test("advertises exactly the workspace role", () => {
		expect(DAYTONA_DESCRIPTOR.roles).toEqual(["workspace"]);
		expect(descriptorSupportsRole(DAYTONA_DESCRIPTOR, "workspace")).toBe(true);
	});

	test("execution is pty only — never streaming-command", () => {
		expect(descriptorSupportsExecution(DAYTONA_DESCRIPTOR, "pty")).toBe(true);
		expect(
			descriptorSupportsExecution(DAYTONA_DESCRIPTOR, "streaming-command"),
		).toBe(false);
		expect(DAYTONA_DESCRIPTOR.execution).toHaveLength(1);
	});

	test("egress advertises deny-all and an IPv4 CIDR allow list capped at 10", () => {
		expect(descriptorSupportsEgress(DAYTONA_DESCRIPTOR, "deny-all")).toBe(true);
		const cidrs = DAYTONA_DESCRIPTOR.egress.find(
			(e) => e.kind === "allow-cidrs",
		);
		expect(cidrs).toBeDefined();
		if (cidrs && cidrs.kind === "allow-cidrs") {
			expect(cidrs.maxEntries).toBe(10);
			expect(cidrs.ipv4Only).toBe(true);
		}
	});

	test("activity is refresh-activity (timer keep-alive, not preview traffic)", () => {
		expect(
			descriptorSupportsActivity(DAYTONA_DESCRIPTOR, "refresh-activity"),
		).toBe(true);
		const activity = DAYTONA_DESCRIPTOR.activity[0];
		expect(activity?.kind).toBe("refresh-activity");
		if (activity?.kind === "refresh-activity") {
			expect(activity.idleStopMs).toBe(15 * 60_000);
		}
	});

	test("onStop keeps disk; durableStore is none (no snapshot reuse in v1)", () => {
		expect(DAYTONA_DESCRIPTOR.onStop).toEqual([{ kind: "keep-disk" }]);
		expect(DAYTONA_DESCRIPTOR.durableStore).toEqual([{ kind: "none" }]);
	});
});
