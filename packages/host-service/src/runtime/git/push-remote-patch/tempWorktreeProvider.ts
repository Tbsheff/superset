import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitFactory } from "../types.ts";
import type { RemoteWorktreeProvider } from "./exportAndPushRemote.ts";

export interface TempWorktreeProviderDeps {
	/** Host git factory (carries user git env); the same one push uses. */
	git: GitFactory;
	/** Absolute path to the project's local clone the worktree forks from. */
	repoPath: string;
}

/**
 * Production `RemoteWorktreeProvider` for the remote export-and-push pipeline.
 * A remote workspace has no host worktree, so the push needs a throwaway one:
 * this checks out `branch` from the project's local clone into a fresh temp dir,
 * fetching the branch from `origin` first so the worktree reflects the upstream
 * tip the runtime forked from. `release` removes the worktree both from git's
 * registry (`worktree remove --force`) and the filesystem.
 *
 * The temp checkout lives under `tmpdir()` (never inside the repo), so a leaked
 * release can't corrupt the project working tree; the patch is applied + pushed
 * here and the dir is discarded immediately afterward.
 */
export function createTempWorktreeProvider(
	deps: TempWorktreeProviderDeps,
): RemoteWorktreeProvider {
	return {
		async acquire({ branch }) {
			const worktreePath = join(
				tmpdir(),
				`superset-remote-push-${randomUUID()}`,
			);
			const git = await deps.git(deps.repoPath);

			// Make the branch available locally so the worktree can check it out.
			// A remote workspace branch may not yet exist on the host clone; fetch
			// best-effort and fall back to the upstream tracking ref on checkout.
			await git
				.raw(["fetch", "origin", `${branch}:${branch}`])
				.catch(() => git.raw(["fetch", "origin"]).catch(() => {}));

			try {
				await git.raw(["worktree", "add", worktreePath, branch]);
			} catch {
				// Branch not present locally — create it tracking the remote tip so
				// the patch applies onto the right base and the push fast-forwards.
				await git.raw([
					"worktree",
					"add",
					"-b",
					branch,
					worktreePath,
					`origin/${branch}`,
				]);
			}

			return { worktreePath };
		},

		async release(worktreePath) {
			const git = await deps.git(deps.repoPath);
			await git
				.raw(["worktree", "remove", "--force", worktreePath])
				.catch(() => {});
			await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
			await git.raw(["worktree", "prune"]).catch(() => {});
		},
	};
}
