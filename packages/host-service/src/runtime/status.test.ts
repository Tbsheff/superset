import { describe, expect, test } from "bun:test";
import {
	cloudToNormalizedStatus,
	normalizedRuntimeStatusValues,
} from "./status.ts";

const cloudSandboxStatusValues = [
	"pending",
	"spawning",
	"connecting",
	"warming",
	"syncing",
	"ready",
	"running",
	"stale",
	"snapshotting",
	"stopped",
	"failed",
] as const;

describe("normalizedRuntimeStatusValues", () => {
	test("has exactly 6 members", () => {
		expect(normalizedRuntimeStatusValues.length).toBe(6);
	});

	test("every normalized member is a projection target of the cloud enum", () => {
		const targets = new Set(Object.values(cloudToNormalizedStatus));
		for (const value of normalizedRuntimeStatusValues) {
			expect(targets.has(value)).toBe(true);
		}
	});
});

describe("cloudToNormalizedStatus", () => {
	test("projects all 11 cloud members", () => {
		expect(Object.keys(cloudToNormalizedStatus).sort()).toEqual(
			[...cloudSandboxStatusValues].sort(),
		);
	});

	test("every projection target is a normalized status", () => {
		for (const target of Object.values(cloudToNormalizedStatus)) {
			expect(normalizedRuntimeStatusValues).toContain(target);
		}
	});
});
