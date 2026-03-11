import { LinearClient } from "@linear/sdk";
import { db } from "@superset/db/client";
import { integrationConnections, type LinearConfig } from "@superset/db/schema";
import { LOCAL_USER_ID } from "@superset/shared/constants";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure } from "../../../trpc";
import { getLinearClient } from "./utils";

export const linearRouter = {
	connectWithToken: publicProcedure
		.input(z.object({ apiToken: z.string().min(1) }))
		.mutation(async ({ input }) => {
			const client = new LinearClient({ accessToken: input.apiToken });
			try {
				const viewer = await client.viewer;
				const org = await viewer.organization;

				await db
					.insert(integrationConnections)
					.values({
						connectedByUserId: LOCAL_USER_ID,
						provider: "linear",
						accessToken: input.apiToken,
						externalOrgId: org.id,
						externalOrgName: org.name,
					})
					.onConflictDoUpdate({
						target: [integrationConnections.provider],
						set: {
							accessToken: input.apiToken,
							externalOrgId: org.id,
							externalOrgName: org.name,
							updatedAt: new Date(),
						},
					});

				return { success: true, orgName: org.name };
			} catch {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid API token. Check your Linear personal API key.",
				});
			}
		}),

	getConnection: publicProcedure
		.input(z.object({}).optional())
		.query(async () => {
			const connection = await db.query.integrationConnections.findFirst({
				where: eq(integrationConnections.provider, "linear"),
				columns: { id: true, config: true },
			});
			if (!connection) return null;
			return { config: connection.config as LinearConfig | null };
		}),

	disconnect: publicProcedure
		.input(z.object({}).optional())
		.mutation(async () => {
			const result = await db
				.delete(integrationConnections)
				.where(eq(integrationConnections.provider, "linear"))
				.returning({ id: integrationConnections.id });

			if (result.length === 0) {
				return { success: false, error: "No connection found" };
			}

			return { success: true };
		}),

	getTeams: publicProcedure
		.input(z.object({ connectionId: z.string().uuid().optional() }).optional())
		.query(async () => {
			const connection = await db.query.integrationConnections.findFirst({
				where: eq(integrationConnections.provider, "linear"),
			});
			if (!connection) return [];
			const client = await getLinearClient();
			if (!client) return [];
			const teams = await client.teams();
			return teams.nodes.map((t) => ({ id: t.id, name: t.name, key: t.key }));
		}),

	updateConfig: publicProcedure
		.input(
			z.object({
				newTasksTeamId: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			const config: LinearConfig = {
				provider: "linear",
				newTasksTeamId: input.newTasksTeamId,
			};

			await db
				.update(integrationConnections)
				.set({ config })
				.where(eq(integrationConnections.provider, "linear"));

			return { success: true };
		}),
} satisfies TRPCRouterRecord;
