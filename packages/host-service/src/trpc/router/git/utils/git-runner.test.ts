import { describe, expect, test } from "bun:test";
import type {
	ExecOptions,
	ExecResult,
	WorkspaceRuntime,
} from "../../../../runtime/seam";
import { buildRemoteGitRunner } from "./git-runner";

function fakeRuntime(
	exec: (command: string, opts?: ExecOptions) => Promise<ExecResult>,
): WorkspaceRuntime {
	return { exec } as unknown as WorkspaceRuntime;
}

describe("buildRemoteGitRunner", () => {
	test("prefixes git and single-quotes each arg", async () => {
		let captured = "";
		const runner = buildRemoteGitRunner(
			fakeRuntime(async (command) => {
				captured = command;
				return { stdout: "ok", stderr: "", exitCode: 0 };
			}),
			"",
		);
		const out = await runner.raw(["status", "--porcelain=v1", "-z"]);
		expect(out).toBe("ok");
		expect(captured).toBe("git 'status' '--porcelain=v1' '-z'");
	});

	test("escapes embedded single quotes in paths", async () => {
		let captured = "";
		const runner = buildRemoteGitRunner(
			fakeRuntime(async (command) => {
				captured = command;
				return { stdout: "", stderr: "", exitCode: 0 };
			}),
			"",
		);
		await runner.raw(["checkout", "HEAD", "--", "weird'name.ts"]);
		expect(captured).toBe("git 'checkout' 'HEAD' '--' 'weird'\\''name.ts'");
	});

	test("rejects on non-zero exit, surfacing combined output", async () => {
		const runner = buildRemoteGitRunner(
			fakeRuntime(async () => ({
				stdout: "fatal: not a git repository",
				stderr: "",
				exitCode: 128,
			})),
			"",
		);
		await expect(runner.raw(["status"])).rejects.toThrow(
			/exited 128.*not a git repository/,
		);
	});

	test("passes cwd through when non-empty", async () => {
		let seenOpts: ExecOptions | undefined;
		const runner = buildRemoteGitRunner(
			fakeRuntime(async (_command, opts) => {
				seenOpts = opts;
				return { stdout: "", stderr: "", exitCode: 0 };
			}),
			"workspace/sub",
		);
		await runner.raw(["status"]);
		expect(seenOpts).toEqual({ cwd: "workspace/sub" });
	});

	test("omits cwd entirely when empty so the runtime uses its default", async () => {
		let seenOpts: ExecOptions | undefined = { cwd: "sentinel" };
		const runner = buildRemoteGitRunner(
			fakeRuntime(async (_command, opts) => {
				seenOpts = opts;
				return { stdout: "", stderr: "", exitCode: 0 };
			}),
			"",
		);
		await runner.raw(["status"]);
		expect(seenOpts).toBeUndefined();
	});

	test("execShell runs the raw script without a git prefix", async () => {
		let captured = "";
		const runner = buildRemoteGitRunner(
			fakeRuntime(async (command) => {
				captured = command;
				return { stdout: "42\n", stderr: "", exitCode: 0 };
			}),
			"",
		);
		const res = await runner.execShell?.("wc -l < 'a.ts'");
		expect(captured).toBe("wc -l < 'a.ts'");
		expect(res).toEqual({ stdout: "42\n", exitCode: 0 });
	});

	test("throws when the runtime cannot exec", () => {
		expect(() =>
			buildRemoteGitRunner({} as unknown as WorkspaceRuntime, ""),
		).toThrow(/does not support command execution/);
	});
});
