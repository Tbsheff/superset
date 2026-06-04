import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimpleGit } from "simple-git";

/**
 * How the exported patch is encoded. `exportPatch()` runs
 * `git format-patch --binary --stdout HEAD` and FALLS BACK to
 * `git diff --binary`, so the host side must handle both shapes:
 *   - `format-patch` output is a mbox: each commit starts with a
 *     `From <40-hex-sha> Mon Sep ...` line. Apply with `git am`.
 *   - `git diff` output is a bare unified diff (`diff --git ...`). Apply with
 *     `git apply --index`.
 */
export type PatchKind = "mailbox" | "unified-diff";

const MAILBOX_HEADER = /^From [0-9a-f]{7,40} /;

/**
 * Classifies the patch bytes by their first line. `format-patch` mbox output
 * always opens with a `From <sha>` line; a bare `git diff` never does. Empty
 * input is treated as a unified diff so the caller surfaces an empty-patch error
 * from `git apply` rather than a confusing `git am` failure.
 */
export function classifyPatch(patch: Buffer): PatchKind {
	const firstLine = patch.toString("utf8", 0, 256).split("\n", 1)[0] ?? "";
	return MAILBOX_HEADER.test(firstLine) ? "mailbox" : "unified-diff";
}

/**
 * Applies a remote-collected patch into the host worktree at `worktreePath`,
 * staging the result. The patch is written to a temp file (binary-safe) and
 * removed afterwards; it is never logged. `git am`/`git apply` run through the
 * passed `SimpleGit` so they inherit the host git env (never raw execFile).
 *
 * On `git am` failure the in-progress am is aborted so the worktree is left
 * clean for the caller to surface the error.
 */
export async function applyPatch(
	git: SimpleGit,
	patch: Buffer,
): Promise<PatchKind> {
	const kind = classifyPatch(patch);
	const patchFile = join(
		tmpdir(),
		`superset-remote-patch-${randomUUID()}.patch`,
	);
	await writeFile(patchFile, patch);
	try {
		if (kind === "mailbox") {
			try {
				await git.raw(["am", "--3way", patchFile]);
			} catch (error) {
				await git.raw(["am", "--abort"]).catch(() => {});
				throw error;
			}
		} else {
			await git.raw(["apply", "--index", "--3way", patchFile]);
		}
		return kind;
	} finally {
		await rm(patchFile, { force: true });
	}
}
