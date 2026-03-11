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
	projects,
	sessionHosts,
	taskStatuses,
	tasks,
	users,
	workspaces,
} from "@superset/db/schema";

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
): Record<string, unknown>[] {
	// biome-ignore lint/suspicious/noExplicitAny: drizzle cross-package type issues
	const selectAll = (table: any) => db.select().from(table).all();

	switch (tableName) {
		case "tasks":
			return selectAll(tasks);
		case "task_statuses":
			return selectAll(taskStatuses);
		case "projects":
			return selectAll(projects);
		case "workspaces":
			return selectAll(workspaces);
		case "auth.users":
			return selectAll(users);
		case "device_presence":
			return selectAll(devicePresence);
		case "agent_commands":
			return selectAll(agentCommands);
		case "integration_connections":
			return selectAll(integrationConnections);
		case "chat_sessions":
			return selectAll(chatSessions);
		case "session_hosts":
			return selectAll(sessionHosts);
		case "github_repositories":
			return selectAll(githubRepositories);
		case "github_pull_requests":
			return selectAll(githubPullRequests);
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

	if (!tableName) {
		return new Response(JSON.stringify({ error: "Missing table parameter" }), {
			status: 400,
			headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
		});
	}

	const rows = queryTable(tableName);
	const serialized = rows.map((row) =>
		applyColumnRestrictions(tableName, serializeRow(row)),
	);

	return new Response(JSON.stringify(serialized), {
		headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
	});
}
