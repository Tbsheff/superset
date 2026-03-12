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
import { z } from "zod";
import { publicProcedure, router } from "../..";

// biome-ignore lint/suspicious/noExplicitAny: drizzle cross-package type issues
async function selectAll(table: any): Promise<Record<string, unknown>[]> {
	return db.select().from(table);
}

async function queryTable(
	tableName: string,
): Promise<Record<string, unknown>[]> {
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
		case "integration_connections": {
			const rows = await selectAll(integrationConnections);
			return rows.map(({ accessToken, refreshToken, ...row }) => row);
		}
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

export const createDataSyncRouter = () => {
	return router({
		getTableRows: publicProcedure
			.input(z.object({ table: z.string() }))
			.query(({ input }) => {
				return queryTable(input.table);
			}),
	});
};

export type DataSyncRouter = ReturnType<typeof createDataSyncRouter>;
