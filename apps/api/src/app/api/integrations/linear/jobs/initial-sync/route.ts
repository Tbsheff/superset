import { LinearClient } from "@linear/sdk";
import { buildConflictUpdateColumns, db } from "@superset/db";
import {
	integrationConnections,
	taskStatuses,
	tasks,
	users,
} from "@superset/db/schema";
import { eq, inArray } from "drizzle-orm";
import chunk from "lodash.chunk";
import { z } from "zod";
import { syncWorkflowStates } from "./syncWorkflowStates";
import { fetchAllIssues, mapIssueToTask } from "./utils";

const BATCH_SIZE = 100;

const payloadSchema = z.object({
	creatorUserId: z.string().min(1),
});

export async function POST(request: Request) {
	const body = await request.text();

	let bodyData: unknown;
	try {
		bodyData = JSON.parse(body);
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const parsed = payloadSchema.safeParse(bodyData);
	if (!parsed.success) {
		return Response.json({ error: "Invalid payload" }, { status: 400 });
	}

	const { creatorUserId } = parsed.data;
	await performLinearInitialSync(creatorUserId);
	return Response.json({ success: true });
}

export async function performLinearInitialSync(creatorUserId: string) {
	const connection = await db.query.integrationConnections.findFirst({
		where: eq(integrationConnections.provider, "linear"),
	});

	if (!connection) {
		throw new Error("No Linear connection found");
	}

	const client = new LinearClient({ accessToken: connection.accessToken });

	await syncWorkflowStates({ client });

	const statusByExternalId = new Map<string, string>();
	const statuses = await db.query.taskStatuses.findMany({
		where: eq(taskStatuses.externalProvider, "linear"),
	});
	for (const status of statuses) {
		if (status.externalId) {
			statusByExternalId.set(status.externalId, status.id);
		}
	}

	const issues = await fetchAllIssues(client);

	if (issues.length === 0) {
		return;
	}

	const assigneeEmails = [
		...new Set(
			issues.map((i) => i.assignee?.email).filter((e): e is string => !!e),
		),
	];

	const matchedUsers =
		assigneeEmails.length > 0
			? await db
					.select({ id: users.id, email: users.email })
					.from(users)
					.where(inArray(users.email, assigneeEmails))
			: [];

	const userByEmail = new Map(matchedUsers.map((u) => [u.email, u.id]));

	const taskValues = issues.map((issue) =>
		mapIssueToTask(issue, creatorUserId, userByEmail, statusByExternalId),
	);

	const batches = chunk(taskValues, BATCH_SIZE);

	for (const batch of batches) {
		await db
			.insert(tasks)
			.values(batch)
			.onConflictDoUpdate({
				target: [tasks.externalProvider, tasks.externalId],
				set: {
					...buildConflictUpdateColumns(tasks, [
						"slug",
						"title",
						"description",
						"statusId",
						"priority",
						"assigneeId",
						"assigneeExternalId",
						"assigneeDisplayName",
						"assigneeAvatarUrl",
						"estimate",
						"dueDate",
						"labels",
						"startedAt",
						"completedAt",
						"externalKey",
						"externalUrl",
						"lastSyncedAt",
					]),
					syncError: null,
				},
			});
	}
}
