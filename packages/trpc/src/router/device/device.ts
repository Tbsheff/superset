import { db } from "@superset/db/client";
import { devicePresence, deviceTypeValues, users } from "@superset/db/schema";
import type { TRPCRouterRecord } from "@trpc/server";
import { eq, gt } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure } from "../../trpc";

const OFFLINE_THRESHOLD_MS = 60_000;

export const deviceRouter = {
	heartbeat: publicProcedure
		.input(
			z.object({
				deviceId: z.string().min(1),
				deviceName: z.string().min(1),
				deviceType: z.enum(deviceTypeValues),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.userId;
			const now = new Date();

			const [device] = await db
				.insert(devicePresence)
				.values({
					userId,
					deviceId: input.deviceId,
					deviceName: input.deviceName,
					deviceType: input.deviceType,
					lastSeenAt: now,
					createdAt: now,
				})
				.onConflictDoUpdate({
					target: [devicePresence.userId, devicePresence.deviceId],
					set: {
						deviceName: input.deviceName,
						deviceType: input.deviceType,
						lastSeenAt: now,
					},
				})
				.returning();

			return { device, timestamp: now };
		}),

	listOnlineDevices: publicProcedure.query(async () => {
		const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS);

		const devices = await db
			.select({
				id: devicePresence.id,
				deviceId: devicePresence.deviceId,
				deviceName: devicePresence.deviceName,
				deviceType: devicePresence.deviceType,
				lastSeenAt: devicePresence.lastSeenAt,
				createdAt: devicePresence.createdAt,
				ownerId: devicePresence.userId,
				ownerName: users.name,
				ownerEmail: users.email,
			})
			.from(devicePresence)
			.innerJoin(users, eq(devicePresence.userId, users.id))
			.where(gt(devicePresence.lastSeenAt, threshold));

		return devices;
	}),
} satisfies TRPCRouterRecord;
