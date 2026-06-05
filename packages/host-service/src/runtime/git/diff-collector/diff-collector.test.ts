import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import simpleGit, { type SimpleGit } from "simple-git";
import { collectFileDiff, collectWorkspacePatch } from "./diff-collector";

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
	return mkdtempSync(join(tmpdir(), "superset-diff-collector-"));
}

describe("collectFileDiff", () => {
	let repo: string;
	let git: SimpleGit;

	beforeEach(async () => {
		repo = mkTmp();
		git = await initRepo(repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("against-base uses merge-base, not the raw base tip", async () => {
		await commitFile(git, repo, "shared.ts", "line1\nline2\nline3\n", "A");
		const forkSha = (await git.revparse(["HEAD"])).trim();
		await git.raw(["update-ref", "refs/remotes/origin/main", forkSha]);
		await git.raw([
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/main",
		]);

		await git.raw(["checkout", "-b", "feature"]);
		await writeFile(join(repo, "shared.ts"), "line1\nBRANCH CHANGED\nline3\n");
		await git.raw(["commit", "-am", "branch edit"]);

		// Advance the base AFTER fork; merge-base content must NOT include it.
		await git.raw(["checkout", "main"]);
		await writeFile(join(repo, "shared.ts"), "line1\nMAIN CHANGED\nline3\n");
		await git.raw(["commit", "-am", "main edit"]);
		await git.raw([
			"update-ref",
			"refs/remotes/origin/main",
			(await git.revparse(["HEAD"])).trim(),
		]);
		await git.raw(["checkout", "feature"]);

		const result = await collectFileDiff(git, {
			category: "against-base",
			path: "shared.ts",
			worktreePath: repo,
			baseBranch: "main",
		});
		expect(result.oldFile.contents).toBe("line1\nline2\nline3\n");
		expect(result.oldFile.contents).not.toContain("MAIN CHANGED");
		expect(result.newFile.contents).toBe("line1\nBRANCH CHANGED\nline3\n");
	});

	test("staged returns HEAD vs index content", async () => {
		await commitFile(git, repo, "a.txt", "committed\n", "base");
		await writeFile(join(repo, "a.txt"), "staged edit\n");
		await git.raw(["add", "a.txt"]);

		const result = await collectFileDiff(git, {
			category: "staged",
			path: "a.txt",
			worktreePath: repo,
		});
		expect(result.oldFile.contents).toBe("committed\n");
		expect(result.newFile.contents).toBe("staged edit\n");
	});

	test("commit with default ^ compares parent vs commit", async () => {
		await commitFile(git, repo, "a.txt", "v1\n", "first");
		await commitFile(git, repo, "a.txt", "v2\n", "second");
		const headSha = (await git.revparse(["HEAD"])).trim();

		const result = await collectFileDiff(git, {
			category: "commit",
			path: "a.txt",
			worktreePath: repo,
			commitHash: headSha,
		});
		expect(result.oldFile.contents).toBe("v1\n");
		expect(result.newFile.contents).toBe("v2\n");
	});

	test("commit with explicit fromHash compares fromHash vs commit", async () => {
		await commitFile(git, repo, "a.txt", "v1\n", "first");
		const firstSha = (await git.revparse(["HEAD"])).trim();
		await commitFile(git, repo, "a.txt", "v2\n", "second");
		await commitFile(git, repo, "a.txt", "v3\n", "third");
		const headSha = (await git.revparse(["HEAD"])).trim();

		const result = await collectFileDiff(git, {
			category: "commit",
			path: "a.txt",
			worktreePath: repo,
			commitHash: headSha,
			fromHash: firstSha,
		});
		expect(result.oldFile.contents).toBe("v1\n");
		expect(result.newFile.contents).toBe("v3\n");
	});

	test("commit without commitHash throws TRPCError BAD_REQUEST", async () => {
		await commitFile(git, repo, "a.txt", "v1\n", "first");
		const promise = collectFileDiff(git, {
			category: "commit",
			path: "a.txt",
			worktreePath: repo,
		});
		await expect(promise).rejects.toThrow(TRPCError);
		await expect(promise).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("unstaged returns index vs raw worktree read", async () => {
		await commitFile(git, repo, "a.txt", "committed\n", "base");
		await writeFile(join(repo, "a.txt"), "staged\n");
		await git.raw(["add", "a.txt"]);
		await writeFile(join(repo, "a.txt"), "working tree\n");

		const result = await collectFileDiff(git, {
			category: "unstaged",
			path: "a.txt",
			worktreePath: repo,
		});
		expect(result.oldFile.contents).toBe("staged\n");
		expect(result.newFile.contents).toBe("working tree\n");
	});

	test("unstaged untracked file → empty old, body new", async () => {
		await commitFile(git, repo, "a.txt", "base\n", "base");
		await writeFile(join(repo, "new.txt"), "fresh body\n");

		const result = await collectFileDiff(git, {
			category: "unstaged",
			path: "new.txt",
			worktreePath: repo,
		});
		expect(result.oldFile.contents).toBe("");
		expect(result.newFile.contents).toBe("fresh body\n");
	});

	test("basename rule: nested path returns leaf name", async () => {
		await commitFile(git, repo, "a.txt", "x\n", "base");
		const result = await collectFileDiff(git, {
			category: "unstaged",
			path: "a/b/c.ts",
			worktreePath: repo,
		});
		expect(result.oldFile.name).toBe("c.ts");
		expect(result.newFile.name).toBe("c.ts");
	});
});

describe("collectWorkspacePatch", () => {
	let repo: string;
	let git: SimpleGit;

	beforeEach(async () => {
		repo = mkTmp();
		git = await initRepo(repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("clean repo → all four fields empty (no throw)", async () => {
		await commitFile(git, repo, "a.txt", "x\n", "base");
		const patch = await collectWorkspacePatch(git);
		expect(patch.status).toBe("");
		expect(patch.unstaged).toBe("");
		expect(patch.staged).toBe("");
		// log is non-empty (one commit) but bounded; assert it's a string.
		expect(typeof patch.log).toBe("string");
	});

	test("staged and unstaged hunks are isolated", async () => {
		await commitFile(git, repo, "staged.txt", "orig-staged\n", "base");
		await commitFile(git, repo, "unstaged.txt", "orig-unstaged\n", "base2");

		await writeFile(join(repo, "staged.txt"), "ALPHA-HUNK\n");
		await git.raw(["add", "staged.txt"]);
		await writeFile(join(repo, "unstaged.txt"), "BETA-HUNK\n");

		const patch = await collectWorkspacePatch(git);
		expect(patch.staged).toContain("ALPHA-HUNK");
		expect(patch.staged).not.toContain("BETA-HUNK");
		expect(patch.unstaged).toContain("BETA-HUNK");
		expect(patch.unstaged).not.toContain("ALPHA-HUNK");
	});

	test("binary change yields a GIT binary patch marker (--binary in effect)", async () => {
		await commitFile(git, repo, "keep.txt", "x\n", "base");
		// Commit a binary blob, then change it so the diff is binary.
		const original = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]);
		await writeFile(join(repo, "blob.bin"), original);
		await git.raw(["add", "blob.bin"]);
		await git.raw(["commit", "-m", "add binary"]);
		const changed = Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x10, 0x20]);
		await writeFile(join(repo, "blob.bin"), changed);

		const patch = await collectWorkspacePatch(git);
		expect(patch.unstaged).toContain("GIT binary patch");
	});

	test("status -z lists an untracked file as ?? <path>\\0", async () => {
		await commitFile(git, repo, "a.txt", "x\n", "base");
		await writeFile(join(repo, "fresh.txt"), "y\n");

		const patch = await collectWorkspacePatch(git);
		expect(patch.status).toContain("?? fresh.txt\0");
	});

	test("log honors logLimit", async () => {
		await commitFile(git, repo, "a.txt", "1\n", "c1");
		await commitFile(git, repo, "b.txt", "2\n", "c2");
		await commitFile(git, repo, "c.txt", "3\n", "c3");

		const patch = await collectWorkspacePatch(git, { logLimit: 2 });
		const lines = patch.log.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(2);
	});

	test("log honors logRange (main..HEAD)", async () => {
		await commitFile(git, repo, "a.txt", "1\n", "base");
		await git.raw(["branch", "base-point"]);
		await git.raw(["checkout", "-b", "feature"]);
		await commitFile(git, repo, "b.txt", "2\n", "branch only");

		const patch = await collectWorkspacePatch(git, {
			logRange: "base-point..HEAD",
		});
		const lines = patch.log.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		expect(patch.log).toContain("branch only");
	});
});
