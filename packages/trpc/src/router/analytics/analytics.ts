import type { TRPCRouterRecord } from "@trpc/server";
import { z } from "zod";
import { publicProcedure } from "../../trpc";

export const analyticsRouter = {
	getActivationFunnel: publicProcedure
		.input(
			z
				.object({
					dateFrom: z.string().optional().default("-7d"),
				})
				.optional(),
		)
		.query(async () => {
			return [];
		}),

	getMarketingFunnel: publicProcedure
		.input(
			z
				.object({
					dateFrom: z.string().optional().default("-7d"),
				})
				.optional(),
		)
		.query(async () => {
			return [];
		}),

	getWAUTrend: publicProcedure
		.input(
			z
				.object({
					days: z.number().min(7).max(180).optional().default(30),
				})
				.optional(),
		)
		.query(async () => {
			return [];
		}),

	getRetention: publicProcedure.query(async () => {
		return [];
	}),

	getWorkspacesLeaderboard: publicProcedure
		.input(
			z
				.object({
					limit: z.number().min(1).max(50).optional().default(10),
					weekOffset: z.number().min(-52).max(0).optional().default(0),
				})
				.optional(),
		)
		.query(async () => {
			return [];
		}),

	getSignupsTrend: publicProcedure
		.input(
			z
				.object({
					days: z.number().min(7).max(180).optional().default(30),
				})
				.optional(),
		)
		.query(async () => {
			return [];
		}),

	getTrafficSources: publicProcedure
		.input(
			z
				.object({
					days: z.number().min(7).max(180).optional().default(30),
				})
				.optional(),
		)
		.query(async () => {
			return [];
		}),

	getRevenueTrend: publicProcedure
		.input(
			z
				.object({
					days: z.number().min(7).max(180).optional().default(30),
				})
				.optional(),
		)
		.query(async () => {
			return [];
		}),
} satisfies TRPCRouterRecord;
