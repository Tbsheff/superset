import { LinearClient } from "@linear/sdk";
import { buildConflictUpdateColumns, db } from "@superset/db";
import {
	integrationConnections,
	taskStatuses,
	tasks,
	users,
} from "@superset/db/schema";
import { eq, inArray } from "drizzle-orm";
import { mapPriorityFromLinear } from "./utils";

const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Workflow state sync
// ---------------------------------------------------------------------------

function calculateProgressForStates(
	states: Array<{ name: string; position: number }>,
): Map<string, number> {
	const progressMap = new Map<string, number>();
	if (states.length === 0) return progressMap;

	const sorted = [...states].sort((a, b) => a.position - b.position);
	const total = sorted.length;

	for (let i = 0; i < total; i++) {
		const state = sorted[i];
		if (!state) continue;
		let progress: number;
		if (total === 1) progress = 50;
		else if (total === 2) progress = i === 0 ? 50 : 75;
		else progress = ((i + 1) / (total + 1)) * 100;
		progressMap.set(state.name, Math.round(progress));
	}
	return progressMap;
}

async function syncWorkflowStates(client: LinearClient): Promise<void> {
	const teams = await client.teams();

	for (const team of teams.nodes) {
		const states = await team.states();

		const statesByType = new Map<string, typeof states.nodes>();
		for (const state of states.nodes) {
			if (!statesByType.has(state.type)) statesByType.set(state.type, []);
			statesByType.get(state.type)?.push(state);
		}

		const startedStates = statesByType.get("started") || [];
		const progressMap = calculateProgressForStates(
			startedStates.map((s) => ({ name: s.name, position: s.position })),
		);

		const values = states.nodes.map((state) => ({
			name: state.name,
			color: state.color,
			type: state.type,
			position: state.position,
			progressPercent:
				state.type === "started" ? (progressMap.get(state.name) ?? null) : null,
			externalProvider: "linear" as const,
			externalId: state.id,
		}));

		if (values.length > 0) {
			await db
				.insert(taskStatuses)
				.values(values)
				.onConflictDoUpdate({
					target: [taskStatuses.externalProvider, taskStatuses.externalId],
					set: {
						...buildConflictUpdateColumns(taskStatuses, [
							"name",
							"color",
							"type",
							"position",
							"progressPercent",
						]),
						updatedAt: new Date(),
					},
				});
		}
	}
}

// ---------------------------------------------------------------------------
// Issue fetch
// ---------------------------------------------------------------------------

interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	priority: number;
	estimate: number | null;
	dueDate: string | null;
	createdAt: string;
	url: string;
	startedAt: string | null;
	completedAt: string | null;
	assignee: {
		id: string;
		email: string;
		name: string;
		avatarUrl: string | null;
	} | null;
	state: { id: string; name: string; color: string; type: string; position: number };
	labels: { nodes: Array<{ id: string; name: string }> };
}

interface IssuesQueryResponse {
	issues: {
		pageInfo: { hasNextPage: boolean; endCursor: string | null };
		nodes: LinearIssue[];
	};
}

const ISSUES_QUERY = `
  query Issues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title description priority estimate dueDate createdAt url startedAt completedAt
        assignee { id email name avatarUrl }
        state { id name color type position }
        labels { nodes { id name } }
      }
    }
  }
`;

async function fetchAllIssues(client: LinearClient): Promise<LinearIssue[]> {
	const allIssues: LinearIssue[] = [];
	let cursor: string | undefined;
	const threeMonthsAgo = new Date();
	threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

	do {
		const response = await client.client.request<
			IssuesQueryResponse,
			{ first: number; after?: string; filter: object }
		>(ISSUES_QUERY, {
			first: 100,
			after: cursor,
			filter: { updatedAt: { gte: threeMonthsAgo.toISOString() } },
		});
		allIssues.push(...response.issues.nodes);
		cursor =
			response.issues.pageInfo.hasNextPage && response.issues.pageInfo.endCursor
				? response.issues.pageInfo.endCursor
				: undefined;
	} while (cursor);

	return allIssues;
}

function mapIssueToTask(
	issue: LinearIssue,
	creatorId: string,
	userByEmail: Map<string, string>,
	statusByExternalId: Map<string, string>,
) {
	const assigneeId = issue.assignee?.email
		? (userByEmail.get(issue.assignee.email) ?? null)
		: null;

	let assigneeExternalId: string | null = null;
	let assigneeDisplayName: string | null = null;
	let assigneeAvatarUrl: string | null = null;

	if (issue.assignee && !assigneeId) {
		assigneeExternalId = issue.assignee.id;
		assigneeDisplayName = issue.assignee.name;
		assigneeAvatarUrl = issue.assignee.avatarUrl;
	}

	const statusId = statusByExternalId.get(issue.state.id);
	if (!statusId) {
		throw new Error(`Status not found for state ${issue.state.id}`);
	}

	return {
		creatorId,
		slug: issue.identifier,
		title: issue.title,
		description: issue.description,
		statusId,
		priority: mapPriorityFromLinear(issue.priority),
		assigneeId,
		assigneeExternalId,
		assigneeDisplayName,
		assigneeAvatarUrl,
		estimate: issue.estimate,
		dueDate: issue.dueDate ? new Date(issue.dueDate) : null,
		labels: issue.labels.nodes.map((l) => l.name),
		startedAt: issue.startedAt ? new Date(issue.startedAt) : null,
		completedAt: issue.completedAt ? new Date(issue.completedAt) : null,
		createdAt: new Date(issue.createdAt),
		externalProvider: "linear" as const,
		externalId: issue.id,
		externalKey: issue.identifier,
		externalUrl: issue.url,
		lastSyncedAt: new Date(),
	};
}

// ---------------------------------------------------------------------------
// Main sync entry point
// ---------------------------------------------------------------------------

export async function performLinearInitialSync(
	creatorUserId: string,
): Promise<{ issueCount: number }> {
	const connection = await db.query.integrationConnections.findFirst({
		where: eq(integrationConnections.provider, "linear"),
	});

	if (!connection) {
		throw new Error("No Linear connection found");
	}

	const client = new LinearClient({ accessToken: connection.accessToken });

	await syncWorkflowStates(client);

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
	if (issues.length === 0) return { issueCount: 0 };

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

	// Batch insert
	for (let i = 0; i < taskValues.length; i += BATCH_SIZE) {
		const batch = taskValues.slice(i, i + BATCH_SIZE);
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

	return { issueCount: issues.length };
}
