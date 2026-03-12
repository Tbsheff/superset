import type { LinearClient, WorkflowState } from "@linear/sdk";
import { db } from "@superset/db/client";
import type { LinearConfig, SelectTask } from "@superset/db/schema";
import {
	integrationConnections,
	taskStatuses,
	tasks,
	users,
} from "@superset/db/schema";
import { eq } from "drizzle-orm";
import { getLinearClient, mapPriorityToLinear } from "./utils";

export async function getNewTasksTeamId(): Promise<string | null> {
	const connection = await db.query.integrationConnections.findFirst({
		where: eq(integrationConnections.provider, "linear"),
	});

	if (!connection?.config) {
		return null;
	}

	const config = connection.config as LinearConfig;
	return config.newTasksTeamId ?? null;
}

async function findLinearState(
	client: LinearClient,
	teamId: string,
	statusName: string,
): Promise<string | undefined> {
	const team = await client.team(teamId);
	const states = await team.states();
	const match = states.nodes.find(
		(s: WorkflowState) => s.name.toLowerCase() === statusName.toLowerCase(),
	);
	return match?.id;
}

async function resolveLinearAssigneeId(
	client: LinearClient,
	userId: string,
): Promise<string | undefined> {
	const matchedUser = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!matchedUser?.email) return undefined;

	const linearUsers = await client.users({
		filter: { email: { eq: matchedUser.email } },
	});
	const linearUser = linearUsers.nodes[0];
	if (linearUsers.nodes.length === 1 && linearUser) {
		return linearUser.id;
	}
	return undefined;
}

export async function syncTaskToLinear(
	task: SelectTask,
	teamId: string,
): Promise<{
	success: boolean;
	externalId?: string;
	externalKey?: string;
	externalUrl?: string;
	error?: string;
}> {
	const client = await getLinearClient();

	if (!client) {
		return { success: false, error: "No Linear connection found" };
	}

	try {
		const taskStatus = await db.query.taskStatuses.findFirst({
			where: eq(taskStatuses.id, task.statusId),
		});

		if (!taskStatus) {
			return { success: false, error: "Task status not found" };
		}

		const stateId = await findLinearState(client, teamId, taskStatus.name);

		if (task.externalProvider === "linear" && task.externalId) {
			let linearAssigneeId: string | null | undefined;
			if (task.assigneeId === null && !task.assigneeExternalId) {
				linearAssigneeId = null;
			} else if (task.assigneeId) {
				linearAssigneeId =
					(await resolveLinearAssigneeId(client, task.assigneeId)) ?? undefined;
			}

			const result = await client.updateIssue(task.externalId, {
				title: task.title,
				description: task.description ?? undefined,
				priority: mapPriorityToLinear(task.priority),
				stateId,
				estimate: task.estimate ?? undefined,
				dueDate: task.dueDate?.toISOString().split("T")[0],
				...(linearAssigneeId !== undefined && { assigneeId: linearAssigneeId }),
			});

			if (!result.success) {
				return { success: false, error: "Failed to update issue" };
			}

			const issue = await result.issue;
			if (!issue) {
				return { success: false, error: "Issue not returned" };
			}

			await db
				.update(tasks)
				.set({
					lastSyncedAt: new Date(),
					syncError: null,
				})
				.where(eq(tasks.id, task.id));

			return {
				success: true,
				externalId: issue.id,
				externalKey: issue.identifier,
				externalUrl: issue.url,
			};
		}

		const createAssigneeId = task.assigneeId
			? await resolveLinearAssigneeId(client, task.assigneeId)
			: undefined;

		const result = await client.createIssue({
			teamId,
			title: task.title,
			description: task.description ?? undefined,
			priority: mapPriorityToLinear(task.priority),
			stateId,
			estimate: task.estimate ?? undefined,
			dueDate: task.dueDate?.toISOString().split("T")[0],
			...(createAssigneeId && { assigneeId: createAssigneeId }),
		});

		if (!result.success) {
			return { success: false, error: "Failed to create issue" };
		}

		const issue = await result.issue;
		if (!issue) {
			return { success: false, error: "Issue not returned" };
		}

		await db
			.update(tasks)
			.set({
				externalProvider: "linear",
				externalId: issue.id,
				externalKey: issue.identifier,
				externalUrl: issue.url,
				lastSyncedAt: new Date(),
				syncError: null,
			})
			.where(eq(tasks.id, task.id));

		return {
			success: true,
			externalId: issue.id,
			externalKey: issue.identifier,
			externalUrl: issue.url,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		await db
			.update(tasks)
			.set({ syncError: errorMessage })
			.where(eq(tasks.id, task.id));

		return { success: false, error: errorMessage };
	}
}

export async function syncTaskToLinearById(taskId: string): Promise<{
	success: boolean;
	externalId?: string;
	externalKey?: string;
	error?: string;
}> {
	const task = await db.query.tasks.findFirst({
		where: eq(tasks.id, taskId),
	});

	if (!task) {
		return { success: false, error: "Task not found" };
	}

	const resolvedTeamId = await getNewTasksTeamId();
	if (!resolvedTeamId) {
		return { success: false, error: "No team configured" };
	}

	return syncTaskToLinear(task, resolvedTeamId);
}
