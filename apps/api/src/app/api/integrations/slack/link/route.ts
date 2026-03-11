import { createHmac } from "node:crypto";
import { db } from "@superset/db/client";
import { integrationConnections, usersSlackUsers } from "@superset/db/schema";
import { LOCAL_USER_ID } from "@superset/shared/constants";
import { and, eq } from "drizzle-orm";
import { env } from "@/env";

export async function GET(request: Request) {
	if (!env.SLACK_SIGNING_SECRET) {
		return Response.json(
			{ error: "Slack integration not configured" },
			{ status: 503 },
		);
	}

	const url = new URL(request.url);
	const token = url.searchParams.get("token");
	const sig = url.searchParams.get("sig");

	if (!token || !sig) {
		return new Response("Missing token or signature", { status: 400 });
	}

	let payload: { slackUserId: string; teamId: string; exp: number };
	try {
		const decoded = Buffer.from(token, "base64url").toString("utf-8");
		const expectedSig = createHmac("sha256", env.SLACK_SIGNING_SECRET)
			.update(decoded)
			.digest("hex");

		if (sig !== expectedSig) {
			return new Response("Invalid signature", { status: 401 });
		}

		payload = JSON.parse(decoded);

		if (Date.now() > payload.exp) {
			return new Response(
				"Link expired. Please try again from the Slack Home tab.",
				{ status: 410 },
			);
		}
	} catch {
		return new Response("Invalid token", { status: 400 });
	}

	const userId = LOCAL_USER_ID;

	const connection = await db.query.integrationConnections.findFirst({
		where: and(
			eq(integrationConnections.provider, "slack"),
			eq(integrationConnections.externalOrgId, payload.teamId),
		),
	});

	if (!connection) {
		return new Response(
			"Slack workspace not connected to any Superset organization.",
			{ status: 404 },
		);
	}

	await db
		.insert(usersSlackUsers)
		.values({
			slackUserId: payload.slackUserId,
			teamId: payload.teamId,
			userId: userId,
		})
		.onConflictDoUpdate({
			target: [usersSlackUsers.slackUserId, usersSlackUsers.teamId],
			set: {
				userId: userId,
			},
		});

	return Response.redirect(
		`${env.NEXT_PUBLIC_WEB_URL}/integrations/slack/linked`,
	);
}
