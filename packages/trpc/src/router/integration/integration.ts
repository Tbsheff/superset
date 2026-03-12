import { db } from "@superset/db/client";
import type { TRPCRouterRecord } from "@trpc/server";
import { z } from "zod";
import { publicProcedure } from "../../trpc";
import { githubRouter } from "./github";
import { linearRouter } from "./linear";
import { slackRouter } from "./slack";

export const integrationRouter = {
	github: githubRouter,
	linear: linearRouter,
	slack: slackRouter,

	list: publicProcedure.input(z.object({}).optional()).query(async () => {
		return db.query.integrationConnections.findMany({
			columns: {
				id: true,
				provider: true,
				externalOrgId: true,
				externalOrgName: true,
				config: true,
				createdAt: true,
				updatedAt: true,
			},
		});
	}),
} satisfies TRPCRouterRecord;
