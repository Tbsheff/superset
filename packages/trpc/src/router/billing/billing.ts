import type { TRPCRouterRecord } from "@trpc/server";
import { publicProcedure } from "../../trpc";

export const billingRouter = {
	// Billing removed — all features are free
	invoices: publicProcedure.query(async () => {
		return [];
	}),
} satisfies TRPCRouterRecord;
