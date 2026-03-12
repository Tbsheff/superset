import { db } from "@superset/db/client";
import {
	githubInstallations,
	githubPullRequests,
	githubRepositories,
} from "@superset/db/schema";
import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../../env";
import { publicProcedure } from "../../../trpc";

export const githubRouter = {
	getInstallation: publicProcedure
		.input(z.object({}).optional())
		.query(async () => {
			const installation = await db.query.githubInstallations.findFirst({
				columns: {
					id: true,
					accountLogin: true,
					accountType: true,
					suspended: true,
					lastSyncedAt: true,
					createdAt: true,
				},
			});

			return installation ?? null;
		}),

	disconnect: publicProcedure
		.input(z.object({ installationId: z.string().uuid() }))
		.mutation(async ({ input }) => {
			const result = await db
				.delete(githubInstallations)
				.where(eq(githubInstallations.id, input.installationId))
				.returning({ id: githubInstallations.id });

			if (result.length === 0) {
				return { success: false, error: "No installation found" };
			}

			return { success: true };
		}),

	triggerSync: publicProcedure
		.input(z.object({}).optional())
		.mutation(async () => {
			const installation = await db.query.githubInstallations.findFirst({
				columns: { id: true },
			});

			if (!installation) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "GitHub installation not found",
				});
			}

			const syncUrl = `${env.NEXT_PUBLIC_API_URL}/api/github/jobs/initial-sync`;
			const syncBody = {
				installationDbId: installation.id,
			};

			fetch(syncUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(syncBody),
			}).catch((error) => {
				console.error("[github/triggerSync] Sync failed:", error);
			});

			return { success: true };
		}),

	listRepositories: publicProcedure
		.input(z.object({}).optional())
		.query(async () => {
			const installation = await db.query.githubInstallations.findFirst({
				columns: { id: true },
			});

			if (!installation) {
				return [];
			}

			return db.query.githubRepositories.findMany({
				where: eq(githubRepositories.installationId, installation.id),
				orderBy: [desc(githubRepositories.updatedAt)],
			});
		}),

	listPullRequests: publicProcedure
		.input(
			z
				.object({
					repositoryId: z.string().uuid().optional(),
					state: z.enum(["open", "closed", "all"]).optional().default("open"),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			const installation = await db.query.githubInstallations.findFirst({
				columns: { id: true },
			});

			if (!installation) {
				return [];
			}

			const repos = await db.query.githubRepositories.findMany({
				where: input?.repositoryId
					? and(
							eq(githubRepositories.installationId, installation.id),
							eq(githubRepositories.id, input.repositoryId),
						)
					: eq(githubRepositories.installationId, installation.id),
				columns: { id: true },
			});

			if (repos.length === 0) {
				return [];
			}

			const repoIds = repos.map((r) => r.id);

			const conditions = [];
			if (repoIds.length > 0) {
				conditions.push(inArray(githubPullRequests.repositoryId, repoIds));
			}

			const state = input?.state ?? "open";
			if (state !== "all") {
				conditions.push(eq(githubPullRequests.state, state));
			}

			return db.query.githubPullRequests.findMany({
				where: conditions.length > 0 ? and(...conditions) : undefined,
				with: {
					repository: {
						columns: {
							id: true,
							fullName: true,
							owner: true,
							name: true,
						},
					},
				},
				orderBy: [desc(githubPullRequests.updatedAt)],
				limit: 100,
			});
		}),

	getStats: publicProcedure.input(z.object({}).optional()).query(async () => {
		const installation = await db.query.githubInstallations.findFirst({
			columns: { id: true },
		});

		if (!installation) {
			return {
				repositoryCount: 0,
				openPullRequestCount: 0,
				pendingChecksCount: 0,
				failedChecksCount: 0,
			};
		}

		const repos = await db.query.githubRepositories.findMany({
			where: eq(githubRepositories.installationId, installation.id),
			columns: { id: true },
		});

		if (repos.length === 0) {
			return {
				repositoryCount: 0,
				openPullRequestCount: 0,
				pendingChecksCount: 0,
				failedChecksCount: 0,
			};
		}

		const repoIds = repos.map((r) => r.id);

		const openPrs = await db.query.githubPullRequests.findMany({
			where: and(
				eq(githubPullRequests.state, "open"),
				inArray(githubPullRequests.repositoryId, repoIds),
			),
			columns: {
				id: true,
				checksStatus: true,
			},
		});

		const pendingChecksCount = openPrs.filter(
			(pr) => pr.checksStatus === "pending",
		).length;
		const failedChecksCount = openPrs.filter(
			(pr) => pr.checksStatus === "failure",
		).length;

		return {
			repositoryCount: repos.length,
			openPullRequestCount: openPrs.length,
			pendingChecksCount,
			failedChecksCount,
		};
	}),
} satisfies TRPCRouterRecord;
