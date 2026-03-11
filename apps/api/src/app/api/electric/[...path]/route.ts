/**
 * Local data endpoint — serves table data from SQLite.
 *
 * Replaces the Electric SQL proxy. Returns plain JSON arrays
 * of rows from the local database, filtered by organization.
 */
import { db } from "@superset/db/client";
import {
	agentCommands,
	chatSessions,
	devicePresence,
	githubPullRequests,
	githubRepositories,
	integrationConnections,
	invitations,
	members,
	organizations,
	projects,
	sessionHosts,
	subscriptions,
	taskStatuses,
	tasks,
	users,
	workspaces,
} from "@superset/db/schema";
import { eq, sql } from "drizzle-orm";

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
};

/** Convert camelCase to snake_case */
function camelToSnake(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Serialize a drizzle row: snake_case keys, ISO dates, stringified JSON arrays/objects */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		const snakeKey = camelToSnake(key);
		if (value instanceof Date) {
			result[snakeKey] = value.toISOString();
		} else if (Array.isArray(value)) {
			result[snakeKey] = JSON.stringify(value);
		} else if (value !== null && typeof value === "object") {
			result[snakeKey] = JSON.stringify(value);
		} else {
			result[snakeKey] = value;
		}
	}
	return result;
}

// Column restrictions for sensitive tables
const COLUMN_RESTRICTIONS: Record<string, Set<string>> = {
	"auth.apikeys": new Set([
		"id",
		"name",
		"start",
		"created_at",
		"last_request",
	]),
	integration_connections: new Set([
		"id",
		"organization_id",
		"connected_by_user_id",
		"provider",
		"token_expires_at",
		"external_org_id",
		"external_org_name",
		"config",
		"created_at",
		"updated_at",
	]),
};

function applyColumnRestrictions(
	tableName: string,
	row: Record<string, unknown>,
): Record<string, unknown> {
	const allowed = COLUMN_RESTRICTIONS[tableName];
	if (!allowed) return row;
	const filtered: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (allowed.has(key)) {
			filtered[key] = value;
		}
	}
	return filtered;
}

function queryTable(
	tableName: string,
	organizationId: string | null,
): Record<string, unknown>[] {
	// biome-ignore lint/suspicious/noExplicitAny: drizzle cross-package type issues
	const orgFilter = (table: any, orgCol: any) => {
		if (organizationId) {
			return db.select().from(table).where(eq(orgCol, organizationId)).all();
		}
		return db.select().from(table).all();
	};

	switch (tableName) {
		case "tasks":
			return orgFilter(tasks, tasks.organizationId);
		case "task_statuses":
			return orgFilter(taskStatuses, taskStatuses.organizationId);
		case "projects":
			return orgFilter(projects, projects.organizationId);
		case "workspaces":
			return orgFilter(workspaces, workspaces.organizationId);
		case "auth.members":
			return orgFilter(members, members.organizationId);
		case "auth.invitations":
			return orgFilter(invitations, invitations.organizationId);
		case "auth.organizations":
			return db.select().from(organizations).all();
		case "auth.users": {
			if (!organizationId) return db.select().from(users).all();
			return db
				.select()
				.from(users)
				.where(
					sql`EXISTS (SELECT 1 FROM json_each(${users.organizationIds}) WHERE json_each.value = ${organizationId})`,
				)
				.all();
		}
		case "device_presence":
			return orgFilter(devicePresence, devicePresence.organizationId);
		case "agent_commands":
			return orgFilter(agentCommands, agentCommands.organizationId);
		case "auth.apikeys": {
			if (!organizationId) return [];
			return db
				.all(
					sql`SELECT id, name, start, created_at, last_request FROM auth_apikeys WHERE metadata LIKE ${"%" + `"organizationId":"${organizationId}"` + "%"}`,
				)
				.map((row) => row as Record<string, unknown>);
		}
		case "integration_connections":
			return orgFilter(
				integrationConnections,
				integrationConnections.organizationId,
			);
		case "subscriptions":
			return orgFilter(subscriptions, subscriptions.referenceId);
		case "chat_sessions":
			return orgFilter(chatSessions, chatSessions.organizationId);
		case "session_hosts":
			return orgFilter(sessionHosts, sessionHosts.organizationId);
		case "github_repositories":
			return orgFilter(
				githubRepositories,
				githubRepositories.organizationId,
			);
		case "github_pull_requests":
			return orgFilter(
				githubPullRequests,
				githubPullRequests.organizationId,
			);
		default:
			return [];
	}
}

export async function OPTIONS(): Promise<Response> {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const tableName = url.searchParams.get("table");
	const organizationId = url.searchParams.get("organizationId");

	if (!tableName) {
		return new Response(JSON.stringify({ error: "Missing table parameter" }), {
			status: 400,
			headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
		});
	}

	const rows = queryTable(tableName, organizationId);
	const serialized = rows.map((row) =>
		applyColumnRestrictions(tableName, serializeRow(row)),
	);

	return new Response(JSON.stringify(serialized), {
		headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
	});
}
