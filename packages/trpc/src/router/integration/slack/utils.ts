import { db } from "@superset/db/client";
import { integrationConnections } from "@superset/db/schema";
import { eq } from "drizzle-orm";

export async function getSlackConnection(_organizationId?: string) {
	const connection = await db.query.integrationConnections.findFirst({
		where: eq(integrationConnections.provider, "slack"),
	});

	return connection ?? null;
}
