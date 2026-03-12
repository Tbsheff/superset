import { db } from "@superset/db/client";
import {
	projects,
	workspaceConfigSchema,
	workspaces,
	workspaceTypeEnum,
} from "@superset/db/schema";
import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure } from "../../trpc";

export const workspaceRouter = {
	ensure: publicProcedure
		.input(
			z.object({
				project: z.object({
					name: z.string().min(1),
					slug: z.string().min(1),
					repoOwner: z.string().min(1),
					repoName: z.string().min(1),
					repoUrl: z.string().url(),
					defaultBranch: z.string().default("main"),
				}),
				workspace: z.object({
					id: z.string().uuid(),
					name: z.string().min(1),
					type: workspaceTypeEnum,
					config: workspaceConfigSchema,
				}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const result = await db.transaction(async (tx) => {
				const [upsertedProject] = await tx
					.insert(projects)
					.values({
						name: input.project.name,
						slug: input.project.slug,
						repoOwner: input.project.repoOwner,
						repoName: input.project.repoName,
						repoUrl: input.project.repoUrl,
						defaultBranch: input.project.defaultBranch,
					})
					.onConflictDoNothing({
						target: [projects.slug],
					})
					.returning();

				const projectRow =
					upsertedProject ??
					(await tx
						.select()
						.from(projects)
						.where(eq(projects.slug, input.project.slug))
						.then((rows) => rows[0]));

				if (!projectRow) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Failed to ensure project",
					});
				}

				await tx
					.insert(workspaces)
					.values({
						id: input.workspace.id,
						projectId: projectRow.id,
						name: input.workspace.name,
						type: input.workspace.type,
						config: input.workspace.config,
						createdByUserId: ctx.userId,
					})
					.onConflictDoNothing({ target: [workspaces.id] });

				return {
					projectId: projectRow.id,
					workspaceId: input.workspace.id,
					txid: 0,
				};
			});

			return result;
		}),

	create: publicProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				name: z.string().min(1),
				type: workspaceTypeEnum,
				config: workspaceConfigSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const [workspace] = await db
				.insert(workspaces)
				.values({
					projectId: input.projectId,
					name: input.name,
					type: input.type,
					config: input.config,
					createdByUserId: ctx.userId,
				})
				.returning();
			return workspace;
		}),

	delete: publicProcedure
		.input(z.object({ id: z.string().uuid() }))
		.mutation(async ({ input }) => {
			await db.delete(workspaces).where(eq(workspaces.id, input.id));
			return { success: true };
		}),
} satisfies TRPCRouterRecord;
