import { db } from "@superset/db/client";
import { agentCommands, commandStatusValues } from "@superset/db/schema";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure } from "../../trpc";

export const agentRouter = {
	updateCommand: publicProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				status: z.enum(commandStatusValues).optional(),
				result: z.record(z.string(), z.unknown()).nullable().optional(),
				error: z.string().nullable().optional(),
				executedAt: z.date().nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { id, ...changes } = input;

			const result = await db.transaction(async (tx) => {
				const [existingCommand] = await tx
					.select()
					.from(agentCommands)
					.where(
						and(eq(agentCommands.id, id), eq(agentCommands.userId, ctx.userId)),
					);

				if (!existingCommand) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Command not found",
					});
				}

				const [updated] = await tx
					.update(agentCommands)
					.set(changes)
					.where(eq(agentCommands.id, id))
					.returning();

				return { command: updated, txid: 0 };
			});

			return result;
		}),
} satisfies TRPCRouterRecord;
