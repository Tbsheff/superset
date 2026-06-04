import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { collectFileDiff } from "../../../runtime/git/diff-collector";

/**
 * Golden regression guard for `git.getDiff`. The tRPC resolver delegates to
 * `collectFileDiff` after resolving the worktree path + git client (input zod
 * schema and worktree resolution unchanged), so asserting `collectFileDiff`'s
 * `{ oldFile, newFile }` output per category pins the endpoint's contract.
 */

async function initRepo(path: string): Promise<SimpleGit> {
	const git = simpleGit(path);
	await git.init();
	await git.raw(["config", "user.email", "test@example.com"]);
	await git.raw(["config", "user.name", "test"]);
	await git.raw(["config", "commit.gpgsign", "false"]);
	await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
	return git;
}

async function commitFile(
	git: SimpleGit,
	cwd: string,
	name: string,
	content: string,
	message: string,
): Promise<void> {
	await writeFile(join(cwd, name), content);
	await git.raw(["add", "--", name]);
	await git.raw(["commit", "-m", message]);
}

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "superset-getdiff-golden-"));
}

describe("getDiff golden output", () => {
	let repo: string;
	let git: SimpleGit;

	beforeEach(async () => {
		repo = mkTmp();
		git = await initRepo(repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("against-base: merge-base content vs HEAD content", async () => {
		await commitFile(git, repo, "shared.ts", "base\n", "A");
		const forkSha = (await git.revparse(["HEAD"])).trim();
		await git.raw(["update-ref", "refs/remotes/origin/main", forkSha]);
		await git.raw([
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/main",
		]);
		await git.raw(["checkout", "-b", "feature"]);
		await writeFile(join(repo, "shared.ts"), "branch\n");
		await git.raw(["commit", "-am", "branch edit"]);

		expect(
			await collectFileDiff(git, {
				category: "against-base",
				path: "shared.ts",
				worktreePath: repo,
				baseBranch: "main",
			}),
		).toEqual({
			oldFile: { name: "shared.ts", contents: "base\n" },
			newFile: { name: "shared.ts", contents: "branch\n" },
		});
	});

	test("staged: HEAD content vs index content", async () => {
		await commitFile(git, repo, "a.txt", "head\n", "base");
		await writeFile(join(repo, "a.txt"), "index\n");
		await git.raw(["add", "a.txt"]);

		expect(
			await collectFileDiff(git, {
				category: "staged",
				path: "a.txt",
				worktreePath: repo,
			}),
		).toEqual({
			oldFile: { name: "a.txt", contents: "head\n" },
			newFile: { name: "a.txt", contents: "index\n" },
		});
	});

	test("commit (default ^): parent vs commit", async () => {
		await commitFile(git, repo, "a.txt", "v1\n", "first");
		await commitFile(git, repo, "a.txt", "v2\n", "second");
		const headSha = (await git.revparse(["HEAD"])).trim();

		expect(
			await collectFileDiff(git, {
				category: "commit",
				path: "a.txt",
				worktreePath: repo,
				commitHash: headSha,
			}),
		).toEqual({
			oldFile: { name: "a.txt", contents: "v1\n" },
			newFile: { name: "a.txt", contents: "v2\n" },
		});
	});

	test("commit (explicit fromHash): fromHash vs commit", async () => {
		await commitFile(git, repo, "a.txt", "v1\n", "first");
		const firstSha = (await git.revparse(["HEAD"])).trim();
		await commitFile(git, repo, "a.txt", "v2\n", "second");
		await commitFile(git, repo, "a.txt", "v3\n", "third");
		const headSha = (await git.revparse(["HEAD"])).trim();

		expect(
			await collectFileDiff(git, {
				category: "commit",
				path: "a.txt",
				worktreePath: repo,
				commitHash: headSha,
				fromHash: firstSha,
			}),
		).toEqual({
			oldFile: { name: "a.txt", contents: "v1\n" },
			newFile: { name: "a.txt", contents: "v3\n" },
		});
	});

	test("unstaged: index content vs raw worktree read", async () => {
		await commitFile(git, repo, "a.txt", "committed\n", "base");
		await writeFile(join(repo, "a.txt"), "indexed\n");
		await git.raw(["add", "a.txt"]);
		await writeFile(join(repo, "a.txt"), "working\n");

		expect(
			await collectFileDiff(git, {
				category: "unstaged",
				path: "a.txt",
				worktreePath: repo,
			}),
		).toEqual({
			oldFile: { name: "a.txt", contents: "indexed\n" },
			newFile: { name: "a.txt", contents: "working\n" },
		});
	});

	test("unstaged untracked: empty old, file body new", async () => {
		await commitFile(git, repo, "a.txt", "x\n", "base");
		await writeFile(join(repo, "untracked.txt"), "body\n");

		expect(
			await collectFileDiff(git, {
				category: "unstaged",
				path: "untracked.txt",
				worktreePath: repo,
			}),
		).toEqual({
			oldFile: { name: "untracked.txt", contents: "" },
			newFile: { name: "untracked.txt", contents: "body\n" },
		});
	});

	test("missing path (deleted): catch path leaves both sides empty", async () => {
		await commitFile(git, repo, "a.txt", "x\n", "base");

		expect(
			await collectFileDiff(git, {
				category: "unstaged",
				path: "does-not-exist.txt",
				worktreePath: repo,
			}),
		).toEqual({
			oldFile: { name: "does-not-exist.txt", contents: "" },
			newFile: { name: "does-not-exist.txt", contents: "" },
		});
	});
});
