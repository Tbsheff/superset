import { snakeCamelMapper } from "@electric-sql/client";
import type {
	SelectProject,
	SelectTask,
	SelectTaskStatus,
	SelectUser,
} from "@superset/db/schema";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import type { Collection } from "@tanstack/react-db";
import { createCollection } from "@tanstack/react-db";
import { authClient } from "../auth/client";
import { env } from "../env";
import { apiClient } from "../trpc/client";

const columnMapper = snakeCamelMapper();
const electricUrl = `${env.EXPO_PUBLIC_API_URL}/api/electric/v1/shape`;

interface Collections {
	tasks: Collection<SelectTask>;
	taskStatuses: Collection<SelectTaskStatus>;
	projects: Collection<SelectProject>;
	users: Collection<SelectUser>;
}

let collectionsInstance: Collections | null = null;

function createAppCollections(): Collections {
	const headers = {
		Cookie: () => authClient.getCookie() || "",
	};

	const tasks = createCollection(
		electricCollectionOptions<SelectTask>({
			id: "tasks",
			shapeOptions: {
				url: electricUrl,
				params: { table: "tasks" },
				headers,
				columnMapper,
			},
			getKey: (item) => item.id,
			onInsert: async ({ transaction }) => {
				const item = transaction.mutations[0].modified;
				const result = await apiClient.task.create.mutate(
					item as Parameters<typeof apiClient.task.create.mutate>[0],
				);
				return { txid: result.txid };
			},
			onUpdate: async ({ transaction }) => {
				const { original, changes } = transaction.mutations[0];
				const result = await apiClient.task.update.mutate({
					...changes,
					id: original.id,
				} as Parameters<typeof apiClient.task.update.mutate>[0]);
				return { txid: result.txid };
			},
			onDelete: async ({ transaction }) => {
				const item = transaction.mutations[0].original;
				const result = await apiClient.task.delete.mutate(item.id);
				return { txid: result.txid };
			},
		}),
	);

	const taskStatuses = createCollection(
		electricCollectionOptions<SelectTaskStatus>({
			id: "task_statuses",
			shapeOptions: {
				url: electricUrl,
				params: { table: "task_statuses" },
				headers,
				columnMapper,
			},
			getKey: (item) => item.id,
		}),
	);

	const projects = createCollection(
		electricCollectionOptions<SelectProject>({
			id: "projects",
			shapeOptions: {
				url: electricUrl,
				params: { table: "projects" },
				headers,
				columnMapper,
			},
			getKey: (item) => item.id,
		}),
	);

	const users = createCollection(
		electricCollectionOptions<SelectUser>({
			id: "users",
			shapeOptions: {
				url: electricUrl,
				params: { table: "auth.users" },
				headers,
				columnMapper,
			},
			getKey: (item) => item.id,
		}),
	);

	return { tasks, taskStatuses, projects, users };
}

export function getCollections() {
	if (!collectionsInstance) {
		collectionsInstance = createAppCollections();
	}
	return collectionsInstance;
}
