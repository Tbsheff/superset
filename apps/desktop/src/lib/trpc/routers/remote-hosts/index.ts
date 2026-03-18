import { remoteHosts } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { getSshConnectionManager } from "main/lib/workspace-runtime/ssh-connection-manager";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { publicProcedure, router } from "../..";

export const createRemoteHostsRouter = () => {
	return router({
		list: publicProcedure.query(() => {
			return localDb.select().from(remoteHosts).all();
		}),

		get: publicProcedure.input(z.string()).query(({ input: id }) => {
			return localDb
				.select()
				.from(remoteHosts)
				.where(eq(remoteHosts.id, id))
				.get();
		}),

		create: publicProcedure
			.input(
				z.object({
					name: z.string().min(1),
					type: z.enum(["ssh", "cloud-sandbox"]),
					hostname: z.string().optional(),
					port: z.number().optional(),
					username: z.string().optional(),
					authMethod: z.enum(["key", "agent", "password"]).optional(),
					privateKeyPath: z.string().optional(),
					defaultCwd: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const id = uuidv4();
				const now = Date.now();
				localDb
					.insert(remoteHosts)
					.values({
						id,
						name: input.name,
						type: input.type,
						hostname: input.hostname,
						port: input.port ?? 22,
						username: input.username,
						authMethod: input.authMethod,
						privateKeyPath: input.privateKeyPath,
						defaultCwd: input.defaultCwd,
						createdAt: now,
						updatedAt: now,
					})
					.run();

				return localDb
					.select()
					.from(remoteHosts)
					.where(eq(remoteHosts.id, id))
					.get();
			}),

		update: publicProcedure
			.input(
				z.object({
					id: z.string(),
					name: z.string().min(1).optional(),
					hostname: z.string().optional(),
					port: z.number().optional(),
					username: z.string().optional(),
					authMethod: z.enum(["key", "agent", "password"]).optional(),
					privateKeyPath: z.string().optional(),
					defaultCwd: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const { id, ...updates } = input;
				localDb
					.update(remoteHosts)
					.set({ ...updates, updatedAt: Date.now() })
					.where(eq(remoteHosts.id, id))
					.run();

				return localDb
					.select()
					.from(remoteHosts)
					.where(eq(remoteHosts.id, id))
					.get();
			}),

		delete: publicProcedure.input(z.string()).mutation(({ input: id }) => {
			// Disconnect any active SSH connection
			const manager = getSshConnectionManager();
			manager.disconnect(id);

			// Delete host (workspace FK auto-nulled via onDelete: "set null")
			localDb.delete(remoteHosts).where(eq(remoteHosts.id, id)).run();
			return { success: true };
		}),

		testConnection: publicProcedure
			.input(
				z.object({
					hostname: z.string(),
					port: z.number().optional(),
					username: z.string(),
					authMethod: z.enum(["key", "agent", "password"]),
					privateKeyPath: z.string().optional(),
					password: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const manager = getSshConnectionManager();
				const testId = `test-${Date.now()}`;

				try {
					await manager.connect({
						id: testId,
						hostname: input.hostname,
						port: input.port ?? 22,
						username: input.username,
						authMethod: input.authMethod,
						privateKeyPath: input.privateKeyPath,
						password: input.password,
					});

					// Successful — clean up test connection
					manager.disconnect(testId);
					return { success: true, error: null };
				} catch (err) {
					manager.disconnect(testId);
					return {
						success: false,
						error: err instanceof Error ? err.message : "Connection failed",
					};
				}
			}),

		connectionStatus: publicProcedure
			.input(z.string())
			.query(({ input: hostId }) => {
				const manager = getSshConnectionManager();
				return { status: manager.getStatus(hostId) };
			}),
	});
};
