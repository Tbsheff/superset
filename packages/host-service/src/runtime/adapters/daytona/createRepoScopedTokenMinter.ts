import { ORGANIZATION_HEADER } from "@superset/shared/constants";
import type { ApiAuthProvider } from "../../../providers/auth/types.ts";
import type { RepoScopedToken, TokenMinter } from "./types.ts";

/**
 * The apps/api route's response shape (`/api/github/scoped-token`):
 * `{ token, expiresAt }`, `expiresAt` in epoch ms. Mirrors `ScopedTokenResponse`
 * in apps/api so a contract drift fails this parse instead of silently minting a
 * malformed token.
 */
interface ScopedTokenWireResponse {
	token: string;
	expiresAt: number;
}

function isScopedTokenResponse(value: unknown): value is ScopedTokenWireResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.token === "string" && typeof v.expiresAt === "number";
}

export interface CreateRepoScopedTokenMinterDeps {
	/** Cloud API base URL (e.g. `https://api.superset.sh`); no trailing slash needed. */
	apiBaseUrl: string;
	/** Same provider the cloud trpc client uses; supplies the `Authorization` header. */
	authProvider: Pick<ApiAuthProvider, "getHeaders">;
	/** Pins the request to this host's bound org, matching the trpc client. */
	organizationId: string;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Builds the production host-side `TokenMinter`. It POSTs `{ owner, repo }` to
 * the apps/api `/api/github/scoped-token` route carrying the host's session auth
 * (the same `Authorization` + org header the cloud trpc client uses), and maps
 * the `{ token, expiresAt }` response to `RepoScopedToken`.
 *
 * The minted token is a write-scoped GitHub credential: it is returned to the
 * caller (the Daytona clone / host push) and NEVER logged, persisted, or placed
 * in an error message. Failures throw a status-only error so the token can never
 * leak through a log line.
 */
export function createRepoScopedTokenMinter(
	deps: CreateRepoScopedTokenMinterDeps,
): TokenMinter {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const endpoint = `${deps.apiBaseUrl.replace(/\/+$/, "")}/api/github/scoped-token`;

	return async ({ owner, repo }): Promise<RepoScopedToken> => {
		const authHeaders = await deps.authProvider.getHeaders();
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				...authHeaders,
				[ORGANIZATION_HEADER]: deps.organizationId,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ owner, repo }),
		});

		if (!response.ok) {
			// Status only: the failure body may echo nothing useful, but the
			// success body carries the token — keep both out of the thrown message.
			throw new Error(
				`Failed to mint repo-scoped token for ${owner}/${repo} (status ${response.status}).`,
			);
		}

		const body: unknown = await response.json();
		if (!isScopedTokenResponse(body)) {
			throw new Error(
				`Repo-scoped token response for ${owner}/${repo} was malformed.`,
			);
		}

		return { token: body.token, expiresAt: body.expiresAt };
	};
}
