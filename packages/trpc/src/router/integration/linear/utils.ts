import { LinearClient } from "@linear/sdk";
import { db } from "@superset/db/client";
import type { TaskPriority } from "@superset/db/enums";
import { integrationConnections } from "@superset/db/schema";
import { eq } from "drizzle-orm";

export function mapPriorityToLinear(priority: string): number {
	switch (priority) {
		case "urgent":
			return 1;
		case "high":
			return 2;
		case "medium":
			return 3;
		case "low":
			return 4;
		default:
			return 0;
	}
}

export function mapPriorityFromLinear(linearPriority: number): TaskPriority {
	switch (linearPriority) {
		case 1:
			return "urgent";
		case 2:
			return "high";
		case 3:
			return "medium";
		case 4:
			return "low";
		default:
			return "none";
	}
}

export async function getLinearClient(
	_organizationId?: string,
): Promise<LinearClient | null> {
	const connection = await db.query.integrationConnections.findFirst({
		where: eq(integrationConnections.provider, "linear"),
	});

	if (!connection) {
		return null;
	}

	return new LinearClient({ accessToken: connection.accessToken });
}
