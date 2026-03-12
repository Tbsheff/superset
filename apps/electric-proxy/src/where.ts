import { eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import type { WhereClause } from "./auth";

// biome-ignore lint/suspicious/noExplicitAny: cross-package drizzle-orm resolution causes type mismatch
function _build(table: any, column: any, id: string): WhereClause {
	const whereExpr = eq(sql`${sql.identifier(column.name)}`, id);
	const qb = new QueryBuilder();
	const { sql: query, params } = qb
		.select()
		.from(table)
		.where(whereExpr)
		.toSQL();
	const fragment = query.replace(/^select .* from .* where\s+/i, "");
	return { fragment, params };
}

export function buildWhereClause(
	tableName: string,
	_organizationId: string,
	_organizationIds: string[],
): WhereClause | null {
	// Organization scoping removed — return no filter for all tables
	// so single-user mode returns all rows.
	switch (tableName) {
		case "tasks":
		case "task_statuses":
		case "projects":
		case "auth.users":
		case "device_presence":
		case "agent_commands":
		case "integration_connections":
		case "workspaces":
		case "chat_sessions":
		case "session_hosts":
		case "github_repositories":
		case "github_pull_requests":
			return null;

		default:
			return null;
	}
}
