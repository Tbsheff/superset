import { db } from "@superset/db/client";
import { integrationConnections } from "@superset/db/schema";
import type { TRPCRouterRecord } from "@trpc/server";
import { eq } from "drizzle-orm";
import { publicProcedure } from "../../../trpc";

export const slackRouter = {
	getConnection: publicProcedure.query(async () => {
		const connection = await db.query.integrationConnections.findFirst({
			where: eq(integrationConnections.provider, "slack"),
			columns: {
				id: true,
				externalOrgName: true,
				createdAt: true,
			},
		});

		if (!connection) return null;

		return {
			id: connection.id,
			externalOrgName: connection.externalOrgName,
			connectedAt: connection.createdAt,
		};
	}),

	disconnect: publicProcedure.mutation(async () => {
		const result = await db
			.delete(integrationConnections)
			.where(eq(integrationConnections.provider, "slack"))
			.returning({ id: integrationConnections.id });

		if (result.length === 0) {
			return { success: false, error: "No connection found" };
		}

		return { success: true };
	}),
} satisfies TRPCRouterRecord;
