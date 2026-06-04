import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import {
	collectFileDiff,
	collectWorkspacePatch,
	type FileDiffRequest,
} from "../git/diff-collector";
import { describeDiffCollectorContract } from "./describeDiffCollectorContract.ts";

const repos: string[] = [];

async function initRepo(): Promise<{ git: SimpleGit; path: string }> {
	const path = mkdtempSync(join(tmpdir(), "superset-diff-contract-"));
	repos.push(path);
	const git = simpleGit(path);
	await git.init();
	await git.raw(["config", "user.email", "test@example.com"]);
	await git.raw(["config", "user.name", "test"]);
	await git.raw(["config", "commit.gpgsign", "false"]);
	await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
	return { git, path };
}

afterAll(() => {
	for (const path of repos) rmSync(path, { recursive: true, force: true });
});

// Local-worktree binding of the diff-collector contract: wraps the shared
// collector functions over a real SimpleGit-backed temp repo. Phase F's
// Daytona adapter binds the same functions over its remote SimpleGit, so a
// green run here proves the contract the remote provider must also satisfy.
describeDiffCollectorContract("local-worktree", async () => {
	const { git, path } = await initRepo();
	return {
		subject: {
			collectWorkspacePatch: () => collectWorkspacePatch(git),
			collectFileDiff: (req: FileDiffRequest) => collectFileDiff(git, req),
		},
		seed: {
			worktreePath: path,
			commitFile: async (name: string, contents: string) => {
				await writeFile(join(path, name), contents);
				await git.raw(["add", "--", name]);
				await git.raw(["commit", "-m", `add ${name}`]);
			},
			writeWorkingFile: async (name: string, contents: string) => {
				await writeFile(join(path, name), contents);
			},
			stage: async (name: string) => {
				await git.raw(["add", "--", name]);
			},
		},
	};
});
