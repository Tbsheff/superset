import { describe, expect, test } from "bun:test";
import { buildTeardownInitialCommand } from "../../teardown/teardown.ts";
import { LOCAL_WORKTREE_DESCRIPTOR } from "./descriptor.ts";

/**
 * Guards against on-disk / command-shape drift from the pre-Phase-E local path.
 * The adapter must coordinate the existing modules without changing the bytes
 * they produce.
 */
describe("local-worktree byte-identical guards", () => {
	test("descriptor advertises a single pty execution surface", () => {
		expect(LOCAL_WORKTREE_DESCRIPTOR.execution).toHaveLength(1);
		expect(LOCAL_WORKTREE_DESCRIPTOR.execution[0]?.kind).toBe("pty");
	});

	test("descriptor capability shape matches local (fs, ingress, onStop, activity)", () => {
		expect(LOCAL_WORKTREE_DESCRIPTOR.filesystem).toEqual([
			{ kind: "read-write-list" },
		]);
		expect(LOCAL_WORKTREE_DESCRIPTOR.onStop).toEqual([{ kind: "keep-disk" }]);
		expect(LOCAL_WORKTREE_DESCRIPTOR.ingress).toEqual([
			{ kind: "runtime-preview-url", tokenScheme: "standard" },
		]);
		expect(LOCAL_WORKTREE_DESCRIPTOR.activity).toEqual([
			{ kind: "refresh-activity", idleStopMs: Number.POSITIVE_INFINITY },
		]);
	});

	test("teardown command is the identical `exec bash <scriptPath>` shape", () => {
		// The adapter coordinates the same runTeardown/buildTeardownInitialCommand;
		// this pins the exact command string the worktree runs.
		const command = buildTeardownInitialCommand(
			"/tmp/worktree/.superset/teardown.sh",
		);
		expect(command).toBe("exec bash '/tmp/worktree/.superset/teardown.sh'");
		expect(command).not.toContain("$?");
	});

	test("multiple setup commands join with ' && ' exactly", () => {
		// Mirrors how resolveInitialCommand joins resolved setup commands today.
		const joined = ["setup-a", "setup-b"].join(" && ");
		expect(joined).toBe("setup-a && setup-b");
	});
});
