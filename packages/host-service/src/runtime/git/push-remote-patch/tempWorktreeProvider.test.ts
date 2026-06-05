import { describe, expect, test } from "bun:test";
import type { SimpleGit } from "simple-git";
import type { GitFactory } from "../types.ts";
import { createTempWorktreeProvider } from "./tempWorktreeProvider.ts";

function makeGitFactory(opts?: { failFirstWorktreeAdd?: boolean }): {
	git: GitFactory;
	calls: string[][];
} {
	const calls: string[][] = [];
	let worktreeAddSeen = 0;
	const git = {
		raw: async (args: string[]) => {
			calls.push(args);
			if (
				opts?.failFirstWorktreeAdd &&
				args[0] === "worktree" &&
				args[1] === "add"
			) {
				worktreeAddSeen += 1;
				// First `worktree add <path> <branch>` (no -b) fails; the -b fallback
				// succeeds.
				if (worktreeAddSeen === 1 && !args.includes("-b")) {
					throw new Error("invalid reference: feat/x");
				}
			}
			return "";
		},
	} as unknown as SimpleGit;
	return {
		git: (async () => git) as unknown as GitFactory,
		calls,
	};
}

describe("createTempWorktreeProvider", () => {
	test("acquire fetches the branch then adds a temp worktree on it", async () => {
		const { git, calls } = makeGitFactory();
		const provider = createTempWorktreeProvider({
			git,
			repoPath: "/repo",
		});

		const { worktreePath } = await provider.acquire({ branch: "feat/x" });

		expect(worktreePath).toMatch(/superset-remote-push-/);
		// A fetch precedes the worktree add.
		expect(calls.some((c) => c[0] === "fetch")).toBe(true);
		const add = calls.find((c) => c[0] === "worktree" && c[1] === "add");
		expect(add).toBeDefined();
		expect(add).toEqual(["worktree", "add", worktreePath, "feat/x"]);
	});

	test("falls back to creating a tracking branch when the local branch is missing", async () => {
		const { git, calls } = makeGitFactory({ failFirstWorktreeAdd: true });
		const provider = createTempWorktreeProvider({
			git,
			repoPath: "/repo",
		});

		const { worktreePath } = await provider.acquire({ branch: "feat/x" });

		const fallback = calls.find(
			(c) => c[0] === "worktree" && c[1] === "add" && c.includes("-b"),
		);
		expect(fallback).toEqual([
			"worktree",
			"add",
			"-b",
			"feat/x",
			worktreePath,
			"origin/feat/x",
		]);
	});

	test("release removes the worktree from git and prunes", async () => {
		const { git, calls } = makeGitFactory();
		const provider = createTempWorktreeProvider({
			git,
			repoPath: "/repo",
		});

		await provider.release("/tmp/superset-remote-push-abc");

		const remove = calls.find((c) => c[0] === "worktree" && c[1] === "remove");
		expect(remove).toEqual([
			"worktree",
			"remove",
			"--force",
			"/tmp/superset-remote-push-abc",
		]);
		expect(calls.some((c) => c[0] === "worktree" && c[1] === "prune")).toBe(
			true,
		);
	});

	test("release swallows a git failure (best-effort cleanup)", async () => {
		const git = (async () =>
			({
				raw: async () => {
					throw new Error("worktree not found");
				},
			}) as unknown as SimpleGit) as unknown as GitFactory;
		const provider = createTempWorktreeProvider({ git, repoPath: "/repo" });
		await expect(
			provider.release("/tmp/superset-remote-push-xyz"),
		).resolves.toBeUndefined();
	});
});
