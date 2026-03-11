import { db } from "@superset/db/client";
import { githubInstallations, members } from "@superset/db/schema";
import { and, eq } from "drizzle-orm";

import { env } from "@/env";
import { verifySignedState } from "@/lib/oauth-state";
import { performGitHubInitialSync } from "../jobs/initial-sync/route";
import { githubApp } from "../octokit";

/**
 * Callback handler for GitHub App installation.
 * GitHub redirects here after the user installs/configures the app.
 */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const installationId = url.searchParams.get("installation_id");
	const setupAction = url.searchParams.get("setup_action");
	const state = url.searchParams.get("state");

	if (setupAction === "cancel") {
		return Response.redirect(
			`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?error=installation_cancelled`,
		);
	}

	if (!installationId || !state) {
		return Response.redirect(
			`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?error=missing_params`,
		);
	}

	const stateData = verifySignedState(state);
	if (!stateData) {
		return Response.redirect(
			`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?error=invalid_state`,
		);
	}

	const { organizationId, userId } = stateData;

	const membership = await db.query.members.findFirst({
		where: and(
			eq(members.organizationId, organizationId),
			eq(members.userId, userId),
		),
	});

	if (!membership) {
		console.error("[github/callback] Membership verification failed:", {
			organizationId,
			userId,
		});
		return Response.redirect(
			`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?error=unauthorized`,
		);
	}

	try {
		const octokit = await githubApp.getInstallationOctokit(
			Number(installationId),
		);

		const installationResult = await octokit
			.request("GET /app/installations/{installation_id}", {
				installation_id: Number(installationId),
			})
			.catch((error: Error) => {
				console.error("[github/callback] Failed to fetch installation:", error);
				return null;
			});

		if (!installationResult) {
			return Response.redirect(
				`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?error=installation_fetch_failed`,
			);
		}

		const installation = installationResult.data;

		const account = installation.account;
		const accountLogin =
			account && "login" in account ? account.login : (account?.name ?? "");
		const accountType =
			account && "type" in account ? account.type : "Organization";

		const [savedInstallation] = await db
			.insert(githubInstallations)
			.values({
				organizationId,
				connectedByUserId: userId,
				installationId: String(installation.id),
				accountLogin,
				accountType,
				permissions: installation.permissions as Record<string, string>,
			})
			.onConflictDoUpdate({
				target: [githubInstallations.organizationId],
				set: {
					connectedByUserId: userId,
					installationId: String(installation.id),
					accountLogin,
					accountType,
					permissions: installation.permissions as Record<string, string>,
					suspended: false,
					suspendedAt: null,
					updatedAt: new Date(),
				},
			})
			.returning();

		if (!savedInstallation) {
			return Response.redirect(
				`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?error=save_failed`,
			);
		}

		try {
			await performGitHubInitialSync(savedInstallation.id, organizationId);
		} catch (error) {
			console.error("[github/callback] Failed to run initial sync:", error);
			return Response.redirect(
				`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?warning=sync_queue_failed`,
			);
		}

		return Response.redirect(
			`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?success=github_installed`,
		);
	} catch (error) {
		console.error("[github/callback] Unexpected error:", error);
		return Response.redirect(
			`${env.NEXT_PUBLIC_WEB_URL}/integrations/github?error=unexpected`,
		);
	}
}
