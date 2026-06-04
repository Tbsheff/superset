import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoScopedToken, TokenMinter } from "./types.ts";

const run = promisify(execFile);

/**
 * Dev-only `TokenMinter` that uses the local `gh` CLI's token instead of a
 * GitHub App installation token. The token carries the user's full gh scope (not
 * repo-scoped), so this is gated to development — a local dev host already trusts
 * the machine's gh session. Production uses `createRepoScopedTokenMinter`.
 */
export function createGhCliTokenMinter(): TokenMinter {
	return async (): Promise<RepoScopedToken> => {
		const { stdout } = await run("gh", ["auth", "token"]);
		const token = stdout.trim();
		if (!token) {
			throw new Error("gh auth token returned empty output");
		}
		return { token, expiresAt: Date.now() + 60 * 60 * 1000 };
	};
}
