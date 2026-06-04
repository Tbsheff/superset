import { describe, expect, test } from "bun:test";
import type {
	FileDiffRequest,
	FileDiffResult,
	WorkspacePatch,
} from "../git/diff-collector";

/**
 * The diff surface a provider must expose for host-side diff collection. Both
 * the local worktree and the Daytona adapter bind these to the shared
 * `collectFileDiff` / `collectWorkspacePatch`, so the same contract proves the
 * remote provider produces a host-collectible patch (the Phase F security gate).
 */
export interface DiffContractSubject {
	collectWorkspacePatch(): Promise<WorkspacePatch>;
	collectFileDiff(req: FileDiffRequest): Promise<FileDiffResult>;
}

/** Seed callbacks the contract uses to drive a subject into a known state. */
export interface DiffContractSeed {
	/** Absolute worktree path, threaded into the unstaged file-diff request. */
	worktreePath: string;
	/** Write a tracked, committed file (`name` relative to the worktree). */
	commitFile(name: string, contents: string): Promise<void>;
	/** Write a file in the working tree without staging it. */
	writeWorkingFile(name: string, contents: string): Promise<void>;
	/** Stage a path. */
	stage(name: string): Promise<void>;
}

/**
 * Descriptor-neutral diff contract bound to a collector-style subject. Asserts:
 * clean repo → empty patch; staged/unstaged isolation; file-diff byte-identity
 * for the `unstaged` category. Provider adapters reuse this with their own
 * `SimpleGit`-backed subject.
 */
export function describeDiffCollectorContract(
	label: string,
	makeSubject: () => Promise<{
		subject: DiffContractSubject;
		seed: DiffContractSeed;
	}>,
): void {
	describe(`diff-collector contract (${label})`, () => {
		test("clean repo → empty status/staged/unstaged patch", async () => {
			const { subject, seed } = await makeSubject();
			await seed.commitFile("a.txt", "x\n");
			const patch = await subject.collectWorkspacePatch();
			expect(patch.status).toBe("");
			expect(patch.staged).toBe("");
			expect(patch.unstaged).toBe("");
		});

		test("staged and unstaged hunks stay isolated", async () => {
			const { subject, seed } = await makeSubject();
			await seed.commitFile("staged.txt", "orig-staged\n");
			await seed.commitFile("unstaged.txt", "orig-unstaged\n");
			await seed.writeWorkingFile("staged.txt", "ALPHA-HUNK\n");
			await seed.stage("staged.txt");
			await seed.writeWorkingFile("unstaged.txt", "BETA-HUNK\n");

			const patch = await subject.collectWorkspacePatch();
			expect(patch.staged).toContain("ALPHA-HUNK");
			expect(patch.staged).not.toContain("BETA-HUNK");
			expect(patch.unstaged).toContain("BETA-HUNK");
			expect(patch.unstaged).not.toContain("ALPHA-HUNK");
		});

		test("file diff returns index vs working-tree contents (unstaged)", async () => {
			const { subject, seed } = await makeSubject();
			await seed.commitFile("a.txt", "committed\n");
			await seed.writeWorkingFile("a.txt", "indexed\n");
			await seed.stage("a.txt");
			await seed.writeWorkingFile("a.txt", "working\n");

			const result = await subject.collectFileDiff({
				category: "unstaged",
				path: "a.txt",
				worktreePath: seed.worktreePath,
			});
			expect(result.oldFile.contents).toBe("indexed\n");
			expect(result.newFile.contents).toBe("working\n");
		});
	});
}
