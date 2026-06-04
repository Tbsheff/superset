import { describe, expect, test } from "bun:test";
import { DaytonaWorkspaceRuntime, type RuntimeSandbox } from "./index.ts";

/**
 * A sandbox stub that answers `executeCommand` from a command→result map and
 * records every command run, so the test asserts BOTH the exact git invocations
 * `getFileContents` issues and how their output maps into the per-file result.
 */
function stubSandbox(
	responses: Record<string, { result: string; exitCode?: number }>,
): {
	sandbox: RuntimeSandbox;
	commands: string[];
} {
	const commands: string[] = [];
	const sandbox = {
		id: "sbx-diff",
		state: "started",
		process: {
			executeCommand: async (command: string, _cwd?: string) => {
				commands.push(command);
				const match = responses[command];
				return match
					? { result: match.result, exitCode: match.exitCode ?? 0 }
					: { result: "", exitCode: 0 };
			},
		},
	} as unknown as RuntimeSandbox;
	return { sandbox, commands };
}

function runtimeFor(sandbox: RuntimeSandbox): DaytonaWorkspaceRuntime {
	const store = {
		insert: () => {},
		setPreviewUrl: () => {},
		markDestroyed: () => {},
		get: () => undefined,
	};
	return new DaytonaWorkspaceRuntime(
		sandbox,
		{ store, now: () => 1 },
		"workspace",
	);
}

describe("DaytonaWorkspaceRuntime.getFileContents", () => {
	test("unstaged: index version vs. working-tree file (cat)", async () => {
		const { sandbox, commands } = stubSandbox({
			"git show ':0:src/app.ts'": { result: "old\n" },
			"cat -- 'src/app.ts'": { result: "old\nnew\n" },
		});
		const runtime = runtimeFor(sandbox);

		const diff = await runtime.getFileContents({
			path: "src/app.ts",
			category: "unstaged",
		});

		expect(diff).toEqual({
			oldFile: { name: "app.ts", contents: "old\n" },
			newFile: { name: "app.ts", contents: "old\nnew\n" },
		});
		expect(commands).toContain("git show ':0:src/app.ts'");
		expect(commands).toContain("cat -- 'src/app.ts'");
	});

	test("staged: HEAD version vs. index version", async () => {
		const { sandbox } = stubSandbox({
			"git show 'HEAD:src/app.ts'": { result: "head\n" },
			"git show ':0:src/app.ts'": { result: "head\nstaged\n" },
		});
		const runtime = runtimeFor(sandbox);

		const diff = await runtime.getFileContents({
			path: "src/app.ts",
			category: "staged",
		});

		expect(diff.oldFile.contents).toBe("head\n");
		expect(diff.newFile.contents).toBe("head\nstaged\n");
	});

	test("against-base: resolves merge-base, then shows both sides", async () => {
		const { sandbox, commands } = stubSandbox({
			"git rev-parse 'main'": { result: "base-sha\n" },
			"git merge-base base-sha HEAD": { result: "mb-sha\n" },
			"git show 'mb-sha:f.ts'": { result: "base\n" },
			"git show 'HEAD:f.ts'": { result: "head\n" },
		});
		const runtime = runtimeFor(sandbox);

		const diff = await runtime.getFileContents({
			path: "f.ts",
			category: "against-base",
			baseBranch: "main",
		});

		expect(diff.oldFile.contents).toBe("base\n");
		expect(diff.newFile.contents).toBe("head\n");
		expect(commands).toContain("git merge-base base-sha HEAD");
	});

	test("commit: shows parent vs. commit, defaulting fromHash to <hash>^", async () => {
		const { sandbox, commands } = stubSandbox({
			"git show 'abc123^:f.ts'": { result: "before\n" },
			"git show 'abc123:f.ts'": { result: "after\n" },
		});
		const runtime = runtimeFor(sandbox);

		const diff = await runtime.getFileContents({
			path: "f.ts",
			category: "commit",
			commitHash: "abc123",
		});

		expect(diff.oldFile.contents).toBe("before\n");
		expect(diff.newFile.contents).toBe("after\n");
		expect(commands).toContain("git show 'abc123^:f.ts'");
	});

	test("commit without commitHash throws", async () => {
		const { sandbox } = stubSandbox({});
		const runtime = runtimeFor(sandbox);

		await expect(
			runtime.getFileContents({ path: "f.ts", category: "commit" }),
		).rejects.toThrow("commitHash is required");
	});

	test("a non-zero exit (missing object) degrades to empty content, not a throw", async () => {
		const { sandbox } = stubSandbox({
			"git show ':0:new.ts'": { result: "fatal: path", exitCode: 128 },
			"cat -- 'new.ts'": { result: "fresh\n" },
		});
		const runtime = runtimeFor(sandbox);

		const diff = await runtime.getFileContents({
			path: "new.ts",
			category: "unstaged",
		});

		// Untracked file: no index side, working-tree content renders as "new".
		expect(diff.oldFile.contents).toBe("");
		expect(diff.newFile.contents).toBe("fresh\n");
	});

	test("single quotes in a path are shell-escaped", async () => {
		const { sandbox, commands } = stubSandbox({});
		const runtime = runtimeFor(sandbox);

		await runtime.getFileContents({ path: "a'b.ts", category: "unstaged" });

		expect(commands).toContain("cat -- 'a'\\''b.ts'");
	});
});
