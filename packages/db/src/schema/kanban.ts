import { sql } from "drizzle-orm";
import {
	index,
	pgTable,
	real,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { organizations, teams, users } from "./auth";
import { githubPullRequests } from "./github";

/**
 * A shared PR-review kanban. Boards/columns/cards are org-scoped (so they ride
 * the existing org Electric shape) with an optional `teamId` for client-side
 * team filtering. Cards link a synced GitHub PR; column membership + `position`
 * (fractional, so a move between two cards never renumbers siblings) are the
 * only team-curated state.
 */
export const kanbanBoards = pgTable(
	"kanban_boards",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		// Null = shared across the whole organization; set = scoped to one team.
		teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
		name: text().notNull(),
		description: text(),
		createdByUserId: uuid("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		deletedAt: timestamp("deleted_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("kanban_boards_organization_id_idx").on(table.organizationId),
		index("kanban_boards_team_id_idx").on(table.teamId),
		index("kanban_boards_deleted_at_idx").on(table.deletedAt),
		// At most one live org-wide default board (team_id NULL) per org, so the
		// idempotent seed can rely on the DB to reject a concurrent duplicate.
		uniqueIndex("kanban_boards_org_default_live_unique")
			.on(table.organizationId)
			.where(sql`${table.deletedAt} IS NULL AND ${table.teamId} IS NULL`),
	],
);

export const kanbanColumns = pgTable(
	"kanban_columns",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		boardId: uuid("board_id")
			.notNull()
			.references(() => kanbanBoards.id, { onDelete: "cascade" }),
		name: text().notNull(),
		position: real().notNull(),
		deletedAt: timestamp("deleted_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("kanban_columns_organization_id_idx").on(table.organizationId),
		index("kanban_columns_board_id_idx").on(table.boardId),
		index("kanban_columns_deleted_at_idx").on(table.deletedAt),
	],
);

export const kanbanCards = pgTable(
	"kanban_cards",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		boardId: uuid("board_id")
			.notNull()
			.references(() => kanbanBoards.id, { onDelete: "cascade" }),
		columnId: uuid("column_id")
			.notNull()
			.references(() => kanbanColumns.id, { onDelete: "cascade" }),
		githubPullRequestId: uuid("github_pull_request_id")
			.notNull()
			.references(() => githubPullRequests.id, { onDelete: "cascade" }),
		position: real().notNull(),
		createdByUserId: uuid("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		deletedAt: timestamp("deleted_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("kanban_cards_organization_id_idx").on(table.organizationId),
		index("kanban_cards_board_id_idx").on(table.boardId),
		index("kanban_cards_column_id_idx").on(table.columnId),
		index("kanban_cards_github_pull_request_id_idx").on(
			table.githubPullRequestId,
		),
		index("kanban_cards_deleted_at_idx").on(table.deletedAt),
		// A PR appears at most once per board among live cards; soft-deleting a
		// card frees the slot so the same PR can be re-added later.
		uniqueIndex("kanban_cards_board_pr_live_unique")
			.on(table.boardId, table.githubPullRequestId)
			.where(sql`${table.deletedAt} IS NULL`),
	],
);

export type InsertKanbanBoard = typeof kanbanBoards.$inferInsert;
export type SelectKanbanBoard = typeof kanbanBoards.$inferSelect;
export type InsertKanbanColumn = typeof kanbanColumns.$inferInsert;
export type SelectKanbanColumn = typeof kanbanColumns.$inferSelect;
export type InsertKanbanCard = typeof kanbanCards.$inferInsert;
export type SelectKanbanCard = typeof kanbanCards.$inferSelect;
