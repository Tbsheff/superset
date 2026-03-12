import { db } from "@superset/db/client";
import { projects, sandboxImages } from "@superset/db/schema";
import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure } from "../../trpc";
import { secretsRouter } from "./secrets";

export const projectRouter = {
	secrets: secretsRouter,

	create: publicProcedure
		.input(
			z.object({
				name: z.string().min(1),
				slug: z.string().min(1),
				repoOwner: z.string().min(1),
				repoName: z.string().min(1),
				repoUrl: z.string().url(),
				defaultBranch: z.string().optional(),
				githubRepositoryId: z.string().uuid().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const [project] = await db
				.insert(projects)
				.values({
					name: input.name,
					slug: input.slug,
					repoOwner: input.repoOwner,
					repoName: input.repoName,
					repoUrl: input.repoUrl,
					defaultBranch: input.defaultBranch ?? "main",
					githubRepositoryId: input.githubRepositoryId,
				})
				.returning();
			if (!project) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to create project",
				});
			}
			await db.insert(sandboxImages).values({
				projectId: project.id,
			});
			return project;
		}),

	update: publicProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				name: z.string().min(1).optional(),
				defaultBranch: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const { id, ...data } = input;
			const [updated] = await db
				.update(projects)
				.set(data)
				.where(eq(projects.id, id))
				.returning();
			return updated;
		}),

	delete: publicProcedure
		.input(z.object({ id: z.string().uuid() }))
		.mutation(async ({ input }) => {
			await db.delete(projects).where(eq(projects.id, input.id));
			return { success: true };
		}),
} satisfies TRPCRouterRecord;
