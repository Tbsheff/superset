import { RuntimeProviderError } from "../../seam/index.ts";
import type { RepoCoordinates } from "./types.ts";

/**
 * Extracts `owner/repo` from an https clone url so the scoped token can be
 * minted for exactly ONE repository. Accepts the common GitHub https form
 * (`https://github.com/owner/repo(.git)`); anything else throws rather than
 * minting a broader-than-intended token.
 */
export function parseRepoCoordinates(cloneUrl: string): RepoCoordinates {
	let pathname: string;
	try {
		pathname = new URL(cloneUrl).pathname;
	} catch {
		throw new RuntimeProviderError(
			"CONFIG_MISSING",
			`daytona: cannot parse repo from clone url: ${cloneUrl}`,
		);
	}
	const parts = pathname.replace(/^\/+/, "").split("/");
	const owner = parts[0];
	const repoRaw = parts[1];
	if (!owner || !repoRaw) {
		throw new RuntimeProviderError(
			"CONFIG_MISSING",
			`daytona: clone url missing owner/repo: ${cloneUrl}`,
		);
	}
	return { owner, repo: repoRaw.replace(/\.git$/, "") };
}
