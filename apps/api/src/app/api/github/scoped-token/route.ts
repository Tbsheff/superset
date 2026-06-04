import { auth } from "@superset/auth/server";
import { db } from "@superset/db/client";
import {
	accounts,
	githubInstallations,
	githubRepositories,
	members,
} from "@superset/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { githubApp } from "../octokit";

/**
 * Repo roles that confer push access. GitHub's permission API exposes both a
 * legacy aggregate `permission` ("admin" | "write" | "read" | "none") and a
 * granular `role_name` ("admin" | "maintain" | "write" | "triage" | "read" |
 * custom). "maintain" collapses to "write" in the legacy field, so we accept
 * either surface reporting one of these roles.
 */
const PUSH_ROLES = new Set(["admin", "maintain", "write"]);

/**
 * Scope of the minted installation token: write source, read metadata, nothing
 * else. The Daytona adapter's clone (in-sandbox) and host-side push are the only
 * consumers; both need exactly this. Widening this object widens every token.
 */
const SCOPED_TOKEN_PERMISSIONS = {
	contents: "write",
	metadata: "read",
} as const;

const bodySchema = z.object({
	owner: z.string().min(1),
	repo: z.string().min(1),
});

export interface ScopedTokenResponse {
	token: string;
	expiresAt: number;
}

/**
 * - `granted`: the caller's GitHub login resolved AND has a push role on the repo.
 * - `denied`: the caller's GitHub login resolved but lacks push access. Hard 403.
 * - `unverifiable`: the caller has no linked GitHub account (login can't be
 *   resolved), so the per-repo check can't run. The route falls back to the
 *   org-membership boundary already established by the caller.
 */
type RepoPushAccess = "granted" | "denied" | "unverifiable";

/**
 * Resolves the caller's GitHub login from their linked GitHub OAuth account and
 * checks their permission level on the specific repo. Returns `unverifiable` if
 * no GitHub account is linked or the login can't be resolved; the caller decides
 * the fallback policy. Never throws on a denied check — only a hard `denied`.
 */
async function verifyRepoPushAccess(args: {
	userId: string;
	owner: string;
	repo: string;
}): Promise<RepoPushAccess> {
	const githubAccount = await db.query.accounts.findFirst({
		where: and(
			eq(accounts.userId, args.userId),
			eq(accounts.providerId, "github"),
		),
		columns: { accountId: true },
	});

	const accountId = githubAccount?.accountId
		? Number(githubAccount.accountId)
		: Number.NaN;
	if (!Number.isInteger(accountId)) {
		return "unverifiable";
	}

	let username: string;
	try {
		const { data: ghUser } = await githubApp.octokit.rest.users.getById({
			account_id: accountId,
		});
		username = ghUser.login;
	} catch {
		// Login can't be resolved (deleted account, transient GitHub error).
		// Treat as unverifiable so the org boundary still applies.
		return "unverifiable";
	}

	try {
		const { data } =
			await githubApp.octokit.rest.repos.getCollaboratorPermissionLevel({
				owner: args.owner,
				repo: args.repo,
				username,
			});
		const granted =
			PUSH_ROLES.has(data.role_name) || PUSH_ROLES.has(data.permission);
		return granted ? "granted" : "denied";
	} catch {
		// GitHub returns 404 when the user is not a collaborator at all. Either
		// way, the caller has no push grant on this repo.
		return "denied";
	}
}

/**
 * Mints a short-lived GitHub App installation access token scoped to a SINGLE
 * repository (`contents:write`, `metadata:read`). The host-side Daytona adapter
 * consumes this via its injected `TokenMinter`; the token rides one TLS call and
 * is never persisted on the host or written into a sandbox.
 *
 * Authorization (two gates, both required):
 *   1. The caller must be an active member of the Superset org that owns the
 *      GitHub installation the repo belongs to (org boundary).
 *   2. The caller must hold push access to the SPECIFIC repo. We resolve the
 *      caller's GitHub login from their linked GitHub OAuth account
 *      (`accounts` where providerId="github", accountId=GitHub numeric user id)
 *      via `users.getById`, then check `repos.getCollaboratorPermissionLevel`
 *      and require a role in {admin, maintain, write}.
 *
 * Residual gap: GitHub is one of several sign-in methods (email/password and
 * Google are also enabled), so a caller may have NO linked GitHub account. When
 * the GitHub login cannot be resolved, gate 2 cannot run; we fall back to the
 * org-membership boundary alone (gate 1). This is the strongest check available
 * for those callers — see `decisionsMade`. The token is never logged.
 */
export async function POST(request: Request): Promise<Response> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return new Response("Unauthorized", { status: 401 });
	}

	let rawBody: unknown;
	try {
		rawBody = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = bodySchema.safeParse(rawBody);
	if (!parsed.success) {
		return Response.json(
			{ error: "Missing or invalid 'owner'/'repo' field" },
			{ status: 400 },
		);
	}

	const { owner, repo } = parsed.data;
	const fullName = `${owner}/${repo}`;

	const repository = await db.query.githubRepositories.findFirst({
		where: eq(githubRepositories.fullName, fullName),
		columns: {
			id: true,
			owner: true,
			name: true,
			organizationId: true,
			installationId: true,
		},
	});

	// Don't distinguish "repo unknown to us" from "you can't access it": both
	// resolve to 403 so this route can't be used to probe which repos exist.
	if (!repository) {
		return Response.json(
			{ error: "Repository not accessible" },
			{ status: 403 },
		);
	}

	const membership = await db.query.members.findFirst({
		where: and(
			eq(members.organizationId, repository.organizationId),
			eq(members.userId, session.user.id),
		),
		columns: { id: true },
	});

	if (!membership) {
		return Response.json(
			{ error: "Repository not accessible" },
			{ status: 403 },
		);
	}

	const installation = await db.query.githubInstallations.findFirst({
		where: eq(githubInstallations.id, repository.installationId),
		columns: { installationId: true, suspended: true },
	});

	if (!installation || installation.suspended) {
		return Response.json(
			{ error: "GitHub installation unavailable" },
			{ status: 409 },
		);
	}

	const repoAccess = await verifyRepoPushAccess({
		userId: session.user.id,
		owner: repository.owner,
		repo: repository.name,
	});

	// Same opaque 403 as "repo not accessible": a caller with a linked GitHub
	// account but no push access learns nothing beyond "not accessible".
	if (repoAccess === "denied") {
		return Response.json(
			{ error: "Repository not accessible" },
			{ status: 403 },
		);
	}

	try {
		const { data } =
			await githubApp.octokit.rest.apps.createInstallationAccessToken({
				installation_id: Number(installation.installationId),
				repositories: [repository.name],
				permissions: SCOPED_TOKEN_PERMISSIONS,
			});

		const response: ScopedTokenResponse = {
			token: data.token,
			expiresAt: new Date(data.expires_at).getTime(),
		};

		return Response.json(response);
	} catch (error) {
		// Log the failure shape, never the token. `error` from octokit here is a
		// request error (status + message), not a token-bearing response.
		console.error("[github/scoped-token] Mint failed:", {
			fullName,
			message: error instanceof Error ? error.message : "unknown error",
		});
		return Response.json({ error: "Failed to mint token" }, { status: 502 });
	}
}
