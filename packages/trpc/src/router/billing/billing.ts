import type { TRPCRouterRecord } from "@trpc/server";
import { protectedProcedure } from "../../trpc";

export const billingRouter = {
	// Billing removed — all features are free
	invoices: protectedProcedure.query(async () => {
		return [];
	}),
} satisfies TRPCRouterRecord;
