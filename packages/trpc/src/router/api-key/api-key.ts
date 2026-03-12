import type { TRPCRouterRecord } from "@trpc/server";
import { publicProcedure } from "../../trpc";

export const apiKeyRouter = {
	// API key management removed — single-user local mode
	create: publicProcedure.mutation(async () => {
		return { key: "local-api-key" };
	}),
} satisfies TRPCRouterRecord;
