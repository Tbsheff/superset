import { LinearClient } from "@linear/sdk";
import { db } from "@superset/db/client";
import { integrationConnections, users } from "@superset/db/schema";
import { LOCAL_USER_ID } from "@superset/shared/constants";
import { eq } from "drizzle-orm";

export async function bootstrapLocalUser() {
	await db
		.insert(users)
		.values({
			id: LOCAL_USER_ID,
			name: "Local User",
			email: "local@localhost",
			emailVerified: true,
		})
		.onConflictDoNothing();
}

export async function bootstrapLinearToken() {
	const token = process.env.LINEAR_API_TOKEN;
	if (!token) return;

	// Check if already connected
	const existing = await db.query.integrationConnections.findFirst({
		where: eq(integrationConnections.provider, "linear"),
	});
	if (existing?.accessToken === token) return;

	// Verify token works and get org info
	try {
		const client = new LinearClient({ accessToken: token });
		const viewer = await client.viewer;
		const org = await viewer.organization;

		await db
			.insert(integrationConnections)
			.values({
				connectedByUserId: LOCAL_USER_ID,
				provider: "linear",
				accessToken: token,
				externalOrgId: org.id,
				externalOrgName: org.name,
			})
			.onConflictDoUpdate({
				target: [integrationConnections.provider],
				set: {
					accessToken: token,
					externalOrgId: org.id,
					externalOrgName: org.name,
					updatedAt: new Date(),
				},
			});

		console.log(`[bootstrap] Linear connected to "${org.name}"`);
	} catch (err) {
		console.error("[bootstrap] LINEAR_API_TOKEN is invalid:", err);
	}
}
