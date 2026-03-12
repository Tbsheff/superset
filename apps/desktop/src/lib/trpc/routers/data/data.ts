import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@superset/db/client";
import { chatSessions } from "@superset/db/schema";
import { LOCAL_USER_ID } from "@superset/shared/constants";
import { createCaller } from "@superset/trpc";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../..";

function getCaller() {
	return createCaller({
		userId: LOCAL_USER_ID,
		headers: new Headers(),
	});
}

export function createDataRouter() {
	return router({
		task: router({
			create: publicProcedure
				.input(z.any())
				.mutation(({ input }) => getCaller().task.create(input)),

			update: publicProcedure
				.input(z.any())
				.mutation(({ input }) => getCaller().task.update(input)),

			delete: publicProcedure
				.input(z.string().uuid())
				.mutation(({ input }) => getCaller().task.delete(input)),
		}),

		agent: router({
			updateCommand: publicProcedure
				.input(
					z.object({
						id: z.string().uuid(),
						status: z.any().optional(),
						result: z.record(z.string(), z.unknown()).nullable().optional(),
						error: z.string().nullable().optional(),
						executedAt: z.date().nullable().optional(),
					}),
				)
				.mutation(({ input }) => getCaller().agent.updateCommand(input)),
		}),

		user: router({
			updateProfile: publicProcedure
				.input(z.object({ name: z.string().min(1).max(100) }))
				.mutation(({ input }) => getCaller().user.updateProfile(input)),

			uploadAvatar: publicProcedure
				.input(
					z.object({
						fileData: z.string(),
						fileName: z.string(),
						mimeType: z.string(),
					}),
				)
				.mutation(({ input }) => getCaller().user.uploadAvatar(input)),
		}),

		device: router({
			heartbeat: publicProcedure
				.input(
					z.object({
						deviceId: z.string().min(1),
						deviceName: z.string().min(1),
						deviceType: z.any(),
					}),
				)
				.mutation(({ input }) => getCaller().device.heartbeat(input)),
		}),

		integration: router({
			github: router({
				getInstallation: publicProcedure.query(() =>
					getCaller().integration.github.getInstallation(),
				),
			}),

			linear: router({
				connectWithToken: publicProcedure
					.input(z.object({ apiToken: z.string().min(1) }))
					.mutation(({ input }) =>
						getCaller().integration.linear.connectWithToken(input),
					),

				disconnect: publicProcedure.mutation(() =>
					getCaller().integration.linear.disconnect(),
				),

				getConnection: publicProcedure.query(() =>
					getCaller().integration.linear.getConnection(),
				),

				getTeams: publicProcedure.query(() =>
					getCaller().integration.linear.getTeams(),
				),

				updateConfig: publicProcedure
					.input(z.object({ newTasksTeamId: z.string() }))
					.mutation(({ input }) =>
						getCaller().integration.linear.updateConfig(input),
					),

				triggerSync: publicProcedure.mutation(() =>
					getCaller().integration.linear.triggerSync(),
				),
			}),
		}),

		project: router({
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
				.mutation(({ input }) => getCaller().project.create(input)),

			secrets: router({
				getDecrypted: publicProcedure
					.input(z.object({ projectId: z.string().uuid() }))
					.query(({ input }) =>
						getCaller().project.secrets.getDecrypted(input),
					),

				upsert: publicProcedure
					.input(
						z.object({
							projectId: z.string().uuid(),
							key: z.string(),
							value: z.string(),
							sensitive: z.boolean().optional(),
						}),
					)
					.mutation(({ input }) => getCaller().project.secrets.upsert(input)),

				delete: publicProcedure
					.input(z.object({ id: z.string().uuid() }))
					.mutation(({ input }) => getCaller().project.secrets.delete(input)),
			}),
		}),

		chat: router({
			getModels: publicProcedure.query(() => getCaller().chat.getModels()),

			updateTitle: publicProcedure
				.input(z.object({ sessionId: z.string().uuid(), title: z.string() }))
				.mutation(({ input }) => getCaller().chat.updateTitle(input)),

			createSession: publicProcedure
				.input(
					z.object({
						sessionId: z.string(),
						workspaceId: z.string().optional(),
					}),
				)
				.mutation(async ({ input }) => {
					const { sessionId, workspaceId } = input;

					const baseValues = {
						id: sessionId,
						createdBy: LOCAL_USER_ID,
					};

					try {
						await db
							.insert(chatSessions)
							.values(workspaceId ? { ...baseValues, workspaceId } : baseValues)
							.onConflictDoNothing();
					} catch (error) {
						// If workspace FK fails, retry without it
						if (workspaceId) {
							const msg =
								error instanceof Error ? error.message.toLowerCase() : "";
							if (msg.includes("foreign key") || msg.includes("workspace_id")) {
								await db
									.insert(chatSessions)
									.values(baseValues)
									.onConflictDoNothing();
							} else {
								throw error;
							}
						} else {
							throw error;
						}
					}

					if (workspaceId) {
						try {
							await db
								.update(chatSessions)
								.set({ workspaceId })
								.where(
									and(
										eq(chatSessions.id, sessionId),
										eq(chatSessions.createdBy, LOCAL_USER_ID),
										isNull(chatSessions.workspaceId),
									),
								);
						} catch {
							// Non-critical: workspace association is best-effort
						}
					}

					return { sessionId };
				}),

			deleteSession: publicProcedure
				.input(z.object({ sessionId: z.string() }))
				.mutation(async ({ input }) => {
					await db
						.delete(chatSessions)
						.where(eq(chatSessions.id, input.sessionId));
					return { success: true };
				}),

			uploadAttachment: publicProcedure
				.input(
					z.object({
						sessionId: z.string(),
						fileData: z.string(),
						fileName: z.string(),
						mediaType: z.string(),
					}),
				)
				.mutation(async ({ input }) => {
					const dir = path.join(
						os.homedir(),
						".superset",
						"data",
						"chat-attachments",
						input.sessionId,
					);
					fs.mkdirSync(dir, { recursive: true });

					const ext = input.fileName.split(".").pop() ?? "bin";
					const randomId = crypto.randomUUID().slice(0, 8);
					const filename = `${randomId}.${ext}`;
					const filePath = path.join(dir, filename);

					// fileData is a base64 data URL like "data:image/png;base64,..."
					const base64Data = input.fileData.includes(",")
						? input.fileData.split(",")[1]!
						: input.fileData;
					const buffer = Buffer.from(base64Data, "base64");
					fs.writeFileSync(filePath, buffer);

					return {
						url: `file://${filePath}`,
						mediaType: input.mediaType,
						filename: input.fileName,
					};
				}),
		}),

		workspace: router({
			ensure: publicProcedure
				.input(z.any())
				.mutation(({ input }) => getCaller().workspace.ensure(input)),
		}),
	});
}
