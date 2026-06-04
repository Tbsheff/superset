import { auth } from "@superset/auth/server";
import { db } from "@superset/db/client";
import {
	githubInstallations,
	githubRepositories,
	members,
} from "@superset/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { githubApp } from "../octokit";

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
 * Mints a short-lived GitHub App installation access token scoped to a SINGLE
 * repository (`contents:write`, `metadata:read`). The host-side Daytona adapter
 * consumes this via its injected `TokenMinter`; the token rides one TLS call and
 * is never persisted on the host or written into a sandbox.
 *
 * Authorization: the caller must be an active member of the Superset org that
 * owns the GitHub installation the repo belongs to. The token is never logged.
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
