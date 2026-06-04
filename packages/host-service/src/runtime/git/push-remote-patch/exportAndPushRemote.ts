import type { WorkspaceRuntime } from "../../seam/index.ts";
import { RuntimeProviderError } from "../../seam/index.ts";
import {
	type PushRemotePatchDeps,
	type PushRemotePatchResult,
	pushRemotePatch,
} from "./pushRemotePatch.ts";

/**
 * Resolves the LIVE `WorkspaceRuntime` for a remote workspace so the patch can be
 * exported INSIDE the runtime. Kept as a seam (not a hard `buildRemoteRuntimeResolver`
 * import) so unit tests inject a fake runtime and never touch Daytona or the
 * network. Production passes the same resolver the exec/diff paths use.
 */
export interface RemotePatchRuntimeResolver {
	resolve(workspaceId: string): Promise<WorkspaceRuntime>;
}

/**
 * Provisions a throwaway host worktree the exported patch is applied + pushed
 * into, then disposes it. A remote workspace has no on-disk worktree
 * (`worktree_path` is the `""` sentinel), so the host can't push directly; it
 * checks out the branch from the project's local clone into a temp path, applies
 * the runtime's patch there, pushes with the scoped token, and removes the temp
 * worktree afterward. Kept as a seam so the orchestrator is testable with git +
 * adapter mocked: a test supplies a fake worktree path and asserts it is always
 * disposed.
 */
export interface RemoteWorktreeProvider {
	/**
	 * Returns an absolute host path with `branch` checked out, ready for
	 * `pushRemotePatch` to apply a patch into and push from.
	 */
	acquire(args: { branch: string }): Promise<{ worktreePath: string }>;
	/** Removes the worktree acquired above. Must not throw on a missing path. */
	release(worktreePath: string): Promise<void>;
}

export interface ExportAndPushRemoteArgs {
	workspaceId: string;
	branch: string;
	/** Upstream repo the scoped token is minted for and the push targets. */
	repo: { owner: string; repo: string };
	resolver: RemotePatchRuntimeResolver;
	worktreeProvider: RemoteWorktreeProvider;
	/** The host push deps (git factory, octokit guard, scoped-token minter). */
	push: PushRemotePatchDeps;
}

/**
 * Host-side export-and-push pipeline for a REMOTE (Daytona) workspace — the final
 * create→use→ship link. The runtime exports a working-tree patch
 * (`exportPatch()`, collected in-sandbox with no broad token); the host applies
 * it into a throwaway worktree checked out from the project's local clone and
 * pushes it with a single-repo-scoped token that NEVER enters the runtime.
 *
 * Order matters: resolve runtime → export patch → (only then) acquire a host
 * worktree → apply + push via `pushRemotePatch` (which guards same-repo BEFORE
 * minting) → always release the worktree. The runtime is resolved before the
 * worktree so a dead sandbox fails before any disk work happens; the worktree is
 * released in a `finally` so a push failure never leaks a temp checkout.
 */
export async function exportAndPushRemote(
	args: ExportAndPushRemoteArgs,
): Promise<PushRemotePatchResult> {
	const { workspaceId, branch, repo, resolver, worktreeProvider, push } = args;

	const runtime = await resolver.resolve(workspaceId);
	if (!runtime.exportPatch) {
		throw new RuntimeProviderError(
			"UNSUPPORTED",
			"Remote runtime does not support patch export on this host.",
		);
	}

	const patch = await runtime.exportPatch();

	const { worktreePath } = await worktreeProvider.acquire({ branch });
	try {
		return await pushRemotePatch(push, {
			worktreePath,
			branch,
			repo,
			patch,
		});
	} finally {
		await worktreeProvider.release(worktreePath).catch((err) => {
			console.warn("[exportAndPushRemote] failed to release temp worktree", {
				worktreePath,
				err,
			});
		});
	}
}
