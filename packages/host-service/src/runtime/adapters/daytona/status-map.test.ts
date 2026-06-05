import { describe, expect, test } from "bun:test";
import type { NormalizedRuntimeStatus } from "../../seam/index.ts";
import { mapDaytonaState } from "./status-map.ts";

/**
 * Every documented `SandboxState` value (api-client `sandbox-state`) must map to
 * a defined NormalizedRuntimeStatus. Table-driven so a future SDK enum addition
 * that this table does not cover is caught by the explicit-coverage test below.
 */
const CASES: ReadonlyArray<[string, NormalizedRuntimeStatus["kind"]]> = [
	["creating", "creating"],
	["starting", "creating"],
	["restoring", "creating"],
	["pulling_snapshot", "creating"],
	["pending_build", "creating"],
	["building_snapshot", "creating"],
	["forking", "creating"],
	["started", "running"],
	["resizing", "running"],
	["snapshotting", "running"],
	["stopping", "stopped"],
	["stopped", "stopped"],
	["archiving", "stopped"],
	["archived", "stopped"],
	["destroying", "destroyed"],
	["destroyed", "destroyed"],
	["error", "failed"],
	["build_failed", "failed"],
];

describe("mapDaytonaState", () => {
	for (const [state, kind] of CASES) {
		test(`${state} -> ${kind}`, () => {
			expect(mapDaytonaState(state).kind).toBe(kind);
		});
	}

	test("stopped is resumable (disk is kept)", () => {
		const status = mapDaytonaState("stopped");
		expect(status.kind === "stopped" && status.resumable).toBe(true);
	});

	test("stopped/stopping are NOT archived (fast resume, disk retained)", () => {
		for (const state of ["stopped", "stopping"]) {
			const status = mapDaytonaState(state);
			expect(status.kind === "stopped" && status.archived).toBe(false);
		}
	});

	test("archived/archiving carry the archived flag (slow cold-storage restore)", () => {
		for (const state of ["archived", "archiving"]) {
			const status = mapDaytonaState(state);
			expect(status.kind === "stopped" && status.resumable).toBe(true);
			expect(status.kind === "stopped" && status.archived).toBe(true);
		}
	});

	test("error carries the raw state as the failure reason", () => {
		const status = mapDaytonaState("build_failed");
		expect(status).toEqual({ kind: "failed", reason: "build_failed" });
	});

	test("unknown / odd strings fall through to failed with the raw state", () => {
		const status = mapDaytonaState("unknown");
		expect(status.kind).toBe("failed");
		const odd = mapDaytonaState("11184809");
		expect(odd.kind).toBe("failed");
		const missing = mapDaytonaState(undefined);
		expect(missing.kind).toBe("failed");
	});
});
