import type { TRPCRouterRecord } from "@trpc/server";
import { z } from "zod";
import { publicProcedure } from "../../trpc";

// Organization concept removed — single-user local mode
export const organizationRouter = {
	all: publicProcedure.query(() => {
		return [];
	}),

	byId: publicProcedure.input(z.string().uuid()).query(() => {
		return null;
	}),

	bySlug: publicProcedure.input(z.string()).query(() => {
		return null;
	}),
} satisfies TRPCRouterRecord;
