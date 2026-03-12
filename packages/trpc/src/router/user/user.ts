import { db } from "@superset/db/client";
import { users } from "@superset/db/schema";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { generateImagePathname, uploadImage } from "../../lib/upload";
import { publicProcedure } from "../../trpc";

export const userRouter = {
	me: publicProcedure.query(async ({ ctx }) => {
		const user = await db.query.users.findFirst({
			where: eq(users.id, ctx.userId),
		});
		return user ?? null;
	}),

	updateProfile: publicProcedure
		.input(z.object({ name: z.string().min(1).max(100) }))
		.mutation(async ({ ctx, input }) => {
			const [updatedUser] = await db
				.update(users)
				.set({ name: input.name })
				.where(eq(users.id, ctx.userId))
				.returning();
			return updatedUser;
		}),

	uploadAvatar: publicProcedure
		.input(
			z.object({
				fileData: z.string(),
				fileName: z.string(),
				mimeType: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.userId;

			const user = await db.query.users.findFirst({
				where: eq(users.id, userId),
			});

			if (!user) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}

			const pathname = generateImagePathname({
				prefix: `user/${userId}/avatar`,
				mimeType: input.mimeType,
			});

			try {
				const url = await uploadImage({
					fileData: input.fileData,
					mimeType: input.mimeType,
					pathname,
					existingUrl: user.image,
				});

				const [updatedUser] = await db
					.update(users)
					.set({ image: url })
					.where(eq(users.id, userId))
					.returning();

				return { success: true, url, user: updatedUser };
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				console.error("[user/uploadAvatar] Upload failed:", error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to upload avatar",
				});
			}
		}),
} satisfies TRPCRouterRecord;
