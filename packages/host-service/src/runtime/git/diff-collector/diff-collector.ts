import { readFile } from "node:fs/promises";
import { TRPCError } from "@trpc/server";
import type { SimpleGit } from "simple-git";
import { resolveBaseComparison } from "../refs";

export type DiffCategory = "against-base" | "staged" | "unstaged" | "commit";

export interface FileDiffRequest {
	category: DiffCategory;
	/** worktree-relative path */
	path: string;
	/** for the unstaged raw-read branch */
	worktreePath: string;
	baseBranch?: string;
	commitHash?: string;
	fromHash?: string;
}

export interface FileDiffResult {
	oldFile: { name: string; contents: string };
	newFile: { name: string; contents: string };
}

/**
 * Per-file content surface — byte-identical to the legacy `git.getDiff`
 * endpoint. Takes a `SimpleGit` so the same code serves the local tRPC
 * endpoint and a remote adapter without re-constructing `simple-git`.
 */
export async function collectFileDiff(
	git: SimpleGit,
	req: FileDiffRequest,
): Promise<FileDiffResult> {
	let originalContent = "";
	let modifiedContent = "";

	if (req.category === "against-base") {
		const base = await resolveBaseComparison(git, req.baseBranch);
		const baseRef = base?.baseRef ?? "HEAD";
		// Use the merge base so the diff excludes unrelated changes landed on
		// the base branch after we forked — matches the 3-dot file list.
		const originRef = await git
			.raw(["merge-base", baseRef, "HEAD"])
			.then((s) => s.trim())
			.catch(() => baseRef);
		try {
			originalContent = await git.show([`${originRef}:${req.path}`]);
		} catch {}
		try {
			modifiedContent = await git.show([`HEAD:${req.path}`]);
		} catch {}
	} else if (req.category === "staged") {
		try {
			originalContent = await git.show([`HEAD:${req.path}`]);
		} catch {}
		try {
			modifiedContent = await git.show([`:0:${req.path}`]);
		} catch {}
	} else if (req.category === "commit") {
		if (!req.commitHash) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "commitHash is required for commit diffs",
			});
		}
		const from = req.fromHash ?? `${req.commitHash}^`;
		try {
			originalContent = await git.show([`${from}:${req.path}`]);
		} catch {}
		try {
			modifiedContent = await git.show([`${req.commitHash}:${req.path}`]);
		} catch {}
	} else {
		// Unstaged: compare index (staged version) against working tree. If the
		// file isn't in the index (untracked), originalContent stays empty so
		// the renderer shows it as a new file.
		try {
			originalContent = await git.show([`:0:${req.path}`]);
		} catch {}
		try {
			modifiedContent = await readFile(
				`${req.worktreePath}/${req.path}`,
				"utf-8",
			);
		} catch {}
	}

	const fileName = req.path.split("/").pop() ?? req.path;
	return {
		oldFile: { name: fileName, contents: originalContent },
		newFile: { name: fileName, contents: modifiedContent },
	};
}

export interface WorkspacePatch {
	/** `git status --porcelain=v1 -z` (NUL-delimited) */
	status: string;
	/** `git diff --binary` */
	unstaged: string;
	/** `git diff --cached --binary` */
	staged: string;
	/** `git log --oneline` (bounded by `logLimit`) */
	log: string;
}

export interface WorkspacePatchOptions {
	/** `baseRef..HEAD` bound for the log surface; default HEAD only. */
	logRange?: string;
	/** cap log lines; default 100. */
	logLimit?: number;
}

/**
 * Whole-workspace patch surface — provider-neutral. The remote (Daytona)
 * adapter reuses this to push diffs host-side. `--binary` keeps binary file
 * changes in the patch; `--porcelain=v1 -z` matches the NUL-delimited parsing
 * used elsewhere in `runtime/git`. Each surface degrades to `""` on a
 * non-repo/empty repo rather than throwing.
 */
export async function collectWorkspacePatch(
	git: SimpleGit,
	options?: WorkspacePatchOptions,
): Promise<WorkspacePatch> {
	const [status, unstaged, staged, log] = await Promise.all([
		git.raw(["status", "--porcelain=v1", "-z"]).catch(() => ""),
		git.raw(["diff", "--binary"]).catch(() => ""),
		git.raw(["diff", "--cached", "--binary"]).catch(() => ""),
		git
			.raw([
				"log",
				"--oneline",
				"-n",
				String(options?.logLimit ?? 100),
				...(options?.logRange ? [options.logRange] : []),
			])
			.catch(() => ""),
	]);
	return { status, unstaged, staged, log };
}
