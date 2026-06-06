import { dbWs } from "@superset/db/client";
import {
	githubPullRequests,
	kanbanBoards,
	kanbanCards,
	kanbanColumns,
} from "@superset/db/schema";
import { getCurrentTxid } from "@superset/db/utils";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure } from "../../trpc";
import { requireActiveOrgMembership } from "../utils/active-org";

const DEFAULT_BOARD_NAME = "Pull Requests";
const DEFAULT_COLUMNS = [
	{ name: "Backlog", position: 1000 },
	{ name: "Reviewing", position: 2000 },
	{ name: "Changes Requested", position: 3000 },
	{ name: "Approved", position: 4000 },
	{ name: "Done", position: 5000 },
];

type Tx = Parameters<Parameters<typeof dbWs.transaction>[0]>[0];

async function assertBoardInOrg(
	tx: Tx,
	boardId: string,
	organizationId: string,
): Promise<void> {
	const [board] = await tx
		.select({ id: kanbanBoards.id })
		.from(kanbanBoards)
		.where(
			and(
				eq(kanbanBoards.id, boardId),
				eq(kanbanBoards.organizationId, organizationId),
				isNull(kanbanBoards.deletedAt),
			),
		)
		.limit(1);
	if (!board) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Board not found" });
	}
}

async function assertColumnInBoard(
	tx: Tx,
	columnId: string,
	boardId: string,
	organizationId: string,
): Promise<void> {
	const [column] = await tx
		.select({ id: kanbanColumns.id })
		.from(kanbanColumns)
		.where(
			and(
				eq(kanbanColumns.id, columnId),
				eq(kanbanColumns.boardId, boardId),
				eq(kanbanColumns.organizationId, organizationId),
				isNull(kanbanColumns.deletedAt),
			),
		)
		.limit(1);
	if (!column) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Column not found" });
	}
}

async function assertPullRequestInOrg(
	tx: Tx,
	pullRequestId: string,
	organizationId: string,
): Promise<void> {
	const [pr] = await tx
		.select({ id: githubPullRequests.id })
		.from(githubPullRequests)
		.where(
			and(
				eq(githubPullRequests.id, pullRequestId),
				eq(githubPullRequests.organizationId, organizationId),
			),
		)
		.limit(1);
	if (!pr) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Pull request not found",
		});
	}
}

const cardRouter = {
	create: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				boardId: z.string().uuid(),
				columnId: z.string().uuid(),
				githubPullRequestId: z.string().uuid(),
				position: z.number(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			return dbWs.transaction(async (tx) => {
				await assertBoardInOrg(tx, input.boardId, organizationId);
				await assertColumnInBoard(
					tx,
					input.columnId,
					input.boardId,
					organizationId,
				);
				await assertPullRequestInOrg(
					tx,
					input.githubPullRequestId,
					organizationId,
				);

				await tx.insert(kanbanCards).values({
					id: input.id,
					organizationId,
					boardId: input.boardId,
					columnId: input.columnId,
					githubPullRequestId: input.githubPullRequestId,
					position: input.position,
					createdByUserId: ctx.session.user.id,
				});

				const txid = await getCurrentTxid(tx);
				return { txid };
			});
		}),

	update: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				columnId: z.string().uuid().optional(),
				position: z.number().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			return dbWs.transaction(async (tx) => {
				const [card] = await tx
					.select({
						boardId: kanbanCards.boardId,
						organizationId: kanbanCards.organizationId,
					})
					.from(kanbanCards)
					.where(
						and(
							eq(kanbanCards.id, input.id),
							eq(kanbanCards.organizationId, organizationId),
							isNull(kanbanCards.deletedAt),
						),
					)
					.limit(1);
				if (!card) {
					throw new TRPCError({ code: "NOT_FOUND", message: "Card not found" });
				}

				if (input.columnId) {
					await assertColumnInBoard(
						tx,
						input.columnId,
						card.boardId,
						organizationId,
					);
				}

				await tx
					.update(kanbanCards)
					.set({
						...(input.columnId ? { columnId: input.columnId } : {}),
						...(input.position !== undefined
							? { position: input.position }
							: {}),
					})
					.where(eq(kanbanCards.id, input.id));

				const txid = await getCurrentTxid(tx);
				return { txid };
			});
		}),

	delete: protectedProcedure
		.input(z.string().uuid())
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			return dbWs.transaction(async (tx) => {
				await tx
					.update(kanbanCards)
					.set({ deletedAt: new Date() })
					.where(
						and(
							eq(kanbanCards.id, input),
							eq(kanbanCards.organizationId, organizationId),
							isNull(kanbanCards.deletedAt),
						),
					);
				const txid = await getCurrentTxid(tx);
				return { txid };
			});
		}),
} satisfies TRPCRouterRecord;

const columnRouter = {
	create: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				boardId: z.string().uuid(),
				name: z.string().min(1),
				position: z.number(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			return dbWs.transaction(async (tx) => {
				await assertBoardInOrg(tx, input.boardId, organizationId);
				await tx.insert(kanbanColumns).values({
					id: input.id,
					organizationId,
					boardId: input.boardId,
					name: input.name,
					position: input.position,
				});
				const txid = await getCurrentTxid(tx);
				return { txid };
			});
		}),

	update: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				name: z.string().min(1).optional(),
				position: z.number().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			return dbWs.transaction(async (tx) => {
				await tx
					.update(kanbanColumns)
					.set({
						...(input.name !== undefined ? { name: input.name } : {}),
						...(input.position !== undefined
							? { position: input.position }
							: {}),
					})
					.where(
						and(
							eq(kanbanColumns.id, input.id),
							eq(kanbanColumns.organizationId, organizationId),
							isNull(kanbanColumns.deletedAt),
						),
					);
				const txid = await getCurrentTxid(tx);
				return { txid };
			});
		}),

	delete: protectedProcedure
		.input(z.string().uuid())
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			return dbWs.transaction(async (tx) => {
				const now = new Date();
				// Soft-delete the column and any live cards still in it so the
				// board never renders cards with a dangling columnId.
				await tx
					.update(kanbanCards)
					.set({ deletedAt: now })
					.where(
						and(
							eq(kanbanCards.columnId, input),
							eq(kanbanCards.organizationId, organizationId),
							isNull(kanbanCards.deletedAt),
						),
					);
				await tx
					.update(kanbanColumns)
					.set({ deletedAt: now })
					.where(
						and(
							eq(kanbanColumns.id, input),
							eq(kanbanColumns.organizationId, organizationId),
							isNull(kanbanColumns.deletedAt),
						),
					);
				const txid = await getCurrentTxid(tx);
				return { txid };
			});
		}),
} satisfies TRPCRouterRecord;

export const kanbanRouter = {
	/**
	 * Idempotently provisions the org's shared PR board + default columns. The
	 * board UI calls this once when no board has synced yet; concurrent callers
	 * see the existing board and no-op. Created rows replicate back via Electric.
	 */
	ensureDefaultBoard: protectedProcedure.mutation(async ({ ctx }) => {
		const organizationId = await requireActiveOrgMembership(ctx);
		// The org's default board is the live, team-unscoped one, guarded by the
		// `kanban_boards_org_default_live_unique` partial index.
		const defaultBoardWhere = and(
			eq(kanbanBoards.organizationId, organizationId),
			isNull(kanbanBoards.deletedAt),
			isNull(kanbanBoards.teamId),
		);

		return dbWs.transaction(async (tx) => {
			const [existing] = await tx
				.select({ id: kanbanBoards.id })
				.from(kanbanBoards)
				.where(defaultBoardWhere)
				.limit(1);

			if (existing) {
				const txid = await getCurrentTxid(tx);
				return { boardId: existing.id, created: false, txid };
			}

			// Race-safe: a concurrent caller that won the insert leaves us with no
			// returned row; re-select its board rather than creating a duplicate.
			const [board] = await tx
				.insert(kanbanBoards)
				.values({
					organizationId,
					name: DEFAULT_BOARD_NAME,
					createdByUserId: ctx.session.user.id,
				})
				.onConflictDoNothing()
				.returning({ id: kanbanBoards.id });

			if (!board) {
				const [winner] = await tx
					.select({ id: kanbanBoards.id })
					.from(kanbanBoards)
					.where(defaultBoardWhere)
					.limit(1);
				if (!winner) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Failed to resolve board after conflict",
					});
				}
				const txid = await getCurrentTxid(tx);
				return { boardId: winner.id, created: false, txid };
			}

			await tx.insert(kanbanColumns).values(
				DEFAULT_COLUMNS.map((column) => ({
					organizationId,
					boardId: board.id,
					name: column.name,
					position: column.position,
				})),
			);

			const txid = await getCurrentTxid(tx);
			return { boardId: board.id, created: true, txid };
		});
	}),

	card: cardRouter,
	column: columnRouter,
} satisfies TRPCRouterRecord;
