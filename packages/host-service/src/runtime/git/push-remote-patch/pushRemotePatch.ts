import { rm } from "node:fs/promises";
import { writeTempAskpass } from "../../../providers/git/CloudGitCredentialProvider/askpass.ts";
import type {
	RepoCoordinates,
	TokenMinter,
} from "../../adapters/daytona/types.ts";
import { RuntimeProviderError } from "../../seam/index.ts";
import type { GitFactory } from "../types.ts";
import { applyPatch, type PatchKind } from "./applyPatch.ts";
import {
	assertSameRepoPushTarget,
	type RepoLookup,
} from "./assertSameRepoPushTarget.ts";

export interface PushRemotePatchInput {
	/** Absolute host worktree path the branch is checked out in. */
	worktreePath: string;
	/** Branch to push (e.g. the workspace's `branch`). */
	branch: string;
	/** Upstream repo the scoped token is minted for and pushed to. */
	repo: RepoCoordinates;
	/** Working-tree patch exported from the remote sandbox. */
	patch: Buffer;
}

export interface PushRemotePatchDeps {
	/** Host git factory carrying user git env; the ONLY way push runs. */
	git: GitFactory;
	/** Octokit-shaped lookup for the SAME-REPO / NON-FORK guard. */
	octokit: RepoLookup;
	/**
	 * Mints the single-repo-scoped token (follow-up #1's `/api/github/scoped-token`
	 * route in production). The token rides a transient askpass for ONE push and
	 * is never logged, persisted, or placed in a remote URL.
	 */
	mintRepoScopedToken: TokenMinter;
}

export interface PushRemotePatchResult {
	branch: string;
	patchKind: PatchKind;
	pushed: true;
}

/**
 * Host-side apply + push for a remote (Daytona) workspace. Keeping a broad token
 * out of the sandbox: the sandbox exports a patch (`exportPatch()`), the host
 * applies it into the real worktree and pushes with a SINGLE-repo-scoped token
 * that only ever lives host-side.
 *
 * Order matters for safety:
 *   1. Guard the target is the upstream repo, not a fork / unwritable repo.
 *   2. Mint the scoped token AFTER the guard so a refused push never mints.
 *   3. Apply the patch into the worktree (staged).
 *   4. Push via the host git factory with the token injected as a transient
 *      askpass env override — never in a URL, never logged.
 *   5. Always remove the askpass file.
 */
export async function pushRemotePatch(
	deps: PushRemotePatchDeps,
	input: PushRemotePatchInput,
): Promise<PushRemotePatchResult> {
	const branch = input.branch.trim();
	if (!branch || branch === "HEAD") {
		throw new RuntimeProviderError(
			"CROSS_REPO_PUSH",
			"Cannot push from detached HEAD; a named branch is required.",
		);
	}
	if (input.patch.byteLength === 0) {
		throw new RuntimeProviderError(
			"CROSS_REPO_PUSH",
			"Refusing to push an empty patch.",
		);
	}

	await assertSameRepoPushTarget(deps.octokit, input.repo);

	const { token } = await deps.mintRepoScopedToken({
		owner: input.repo.owner,
		repo: input.repo.repo,
	});

	const git = await deps.git(input.worktreePath);
	const patchKind = await applyPatch(git, input.patch);

	const askpassPath = await writeTempAskpass(token);
	try {
		await git
			.env({ GIT_ASKPASS: askpassPath, GIT_TERMINAL_PROMPT: "0" })
			.push(["--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
	} finally {
		await rm(askpassPath, { force: true });
	}

	return { branch, patchKind, pushed: true };
}
