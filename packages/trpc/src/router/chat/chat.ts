import { db } from "@superset/db/client";
import { chatSessions } from "@superset/db/schema";
import type { TRPCRouterRecord } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure } from "../../trpc";

const AVAILABLE_MODELS = [
	{
		id: "anthropic/claude-opus-4-6",
		name: "Opus 4.6",
		provider: "Anthropic",
	},
	{
		id: "anthropic/claude-sonnet-4-6",
		name: "Sonnet 4.6",
		provider: "Anthropic",
	},
	{
		id: "anthropic/claude-haiku-4-5",
		name: "Haiku 4.5",
		provider: "Anthropic",
	},
	{
		id: "openai/gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		provider: "OpenAI",
	},
	{
		id: "openai/gpt-5.2",
		name: "GPT-5.2",
		provider: "OpenAI",
	},
];

export const chatRouter = {
	getModels: publicProcedure.query(() => {
		return { models: AVAILABLE_MODELS };
	}),

	updateTitle: publicProcedure
		.input(z.object({ sessionId: z.uuid(), title: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const [updated] = await db
				.update(chatSessions)
				.set({ title: input.title })
				.where(
					and(
						eq(chatSessions.id, input.sessionId),
						eq(chatSessions.createdBy, ctx.userId),
					),
				)
				.returning({ id: chatSessions.id });
			return { updated: !!updated };
		}),
} satisfies TRPCRouterRecord;
