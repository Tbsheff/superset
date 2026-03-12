import type {
	SelectAgentCommand,
	SelectChatSession,
	SelectDevicePresence,
	SelectGithubPullRequest,
	SelectGithubRepository,
	SelectIntegrationConnection,
	SelectProject,
	SelectSessionHost,
	SelectTask,
	SelectTaskStatus,
	SelectUser,
	SelectWorkspace,
} from "@superset/db/schema";
import type { Collection } from "@tanstack/react-db";
import { createCollection } from "@tanstack/react-db";
import { electronTrpcClient } from "renderer/lib/trpc-client";

type IntegrationConnectionDisplay = Omit<
	SelectIntegrationConnection,
	"accessToken" | "refreshToken"
>;

interface Collections {
	tasks: Collection<SelectTask, string>;
	taskStatuses: Collection<SelectTaskStatus, string>;
	projects: Collection<SelectProject, string>;
	workspaces: Collection<SelectWorkspace, string>;
	users: Collection<SelectUser, string>;
	agentCommands: Collection<SelectAgentCommand, string>;
	devicePresence: Collection<SelectDevicePresence, string>;
	integrationConnections: Collection<IntegrationConnectionDisplay, string>;
	chatSessions: Collection<SelectChatSession, string>;
	sessionHosts: Collection<SelectSessionHost, string>;
	githubRepositories: Collection<SelectGithubRepository, string>;
	githubPullRequests: Collection<SelectGithubPullRequest, string>;
}

// ---------------------------------------------------------------------------
// IPC-based sync — queries local SQLite via electron tRPC
// ---------------------------------------------------------------------------

const POLL_INTERVAL = 5_000; // 5 seconds

/** Fetch rows from local SQLite via IPC */
async function fetchRows<T>(table: string): Promise<T[]> {
	return electronTrpcClient.dataSync.getTableRows.query({ table }) as Promise<
		T[]
	>;
}

/**
 * Create collection options with an IPC-based sync.
 * Loads data from local SQLite on mount and polls for updates.
 */
function fetchCollectionOptions<T extends object>(config: {
	id: string;
	table: string;
	getKey: (item: T) => string;
	onInsert?: (params: {
		transaction: { mutations: Array<{ modified: T }> };
	}) => Promise<{ txid: number } | undefined>;
	onUpdate?: (params: {
		transaction: {
			mutations: Array<{ original: T; changes: Partial<T> }>;
		};
	}) => Promise<{ txid: number } | undefined>;
	onDelete?: (params: {
		transaction: { mutations: Array<{ original: T }> };
	}) => Promise<{ txid: number } | undefined>;
}) {
	return {
		id: config.id,
		getKey: config.getKey,
		onInsert: config.onInsert,
		onUpdate: config.onUpdate,
		onDelete: config.onDelete,
		sync: {
			rowUpdateMode: "full" as const,
			sync: ({
				begin,
				write,
				commit,
				markReady,
			}: {
				begin: () => void;
				write: (msg: {
					key: string;
					value: T;
					type: "insert" | "update" | "delete";
				}) => void;
				commit: () => void;
				markReady: () => void;
			}) => {
				let stopped = false;
				let timer: ReturnType<typeof setTimeout> | null = null;

				async function load() {
					try {
						const rows = await fetchRows<T>(config.table);
						if (stopped) return;
						begin();
						for (const row of rows) {
							write({
								key: config.getKey(row),
								value: row,
								type: "insert",
							});
						}
						commit();
						markReady();
					} catch (err) {
						console.error(`[collections] Sync failed for ${config.id}:`, err);
						// Still mark ready so the UI doesn't hang on loading state
						markReady();
					}
				}

				function poll() {
					if (stopped) return;
					timer = setTimeout(async () => {
						await load();
						poll();
					}, POLL_INTERVAL);
				}

				// Initial load
				void load().then(poll);

				return () => {
					stopped = true;
					if (timer) clearTimeout(timer);
				};
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Collection factories — lazy singleton
// ---------------------------------------------------------------------------

let collectionsInstance: Collections | null = null;

function createCollections(): Collections {
	const tasks = createCollection(
		fetchCollectionOptions<SelectTask>({
			id: "tasks",
			table: "tasks",
			getKey: (item) => item.id,
			onInsert: async ({ transaction }) => {
				const item = transaction.mutations[0].modified;
				const result = await electronTrpcClient.data.task.create.mutate(item);
				return { txid: result.txid };
			},
			onUpdate: async ({ transaction }) => {
				const { original, changes } = transaction.mutations[0];
				const result = await electronTrpcClient.data.task.update.mutate({
					...changes,
					id: original.id,
				});
				return { txid: result.txid };
			},
			onDelete: async ({ transaction }) => {
				const item = transaction.mutations[0].original;
				const result = await electronTrpcClient.data.task.delete.mutate(
					item.id,
				);
				return { txid: result.txid };
			},
		}),
	);

	const taskStatuses = createCollection(
		fetchCollectionOptions<SelectTaskStatus>({
			id: "task_statuses",
			table: "task_statuses",
			getKey: (item) => item.id,
		}),
	);

	const projects = createCollection(
		fetchCollectionOptions<SelectProject>({
			id: "projects",
			table: "projects",
			getKey: (item) => item.id,
		}),
	);

	const workspaces = createCollection(
		fetchCollectionOptions<SelectWorkspace>({
			id: "workspaces",
			table: "workspaces",
			getKey: (item) => item.id,
		}),
	);

	const users = createCollection(
		fetchCollectionOptions<SelectUser>({
			id: "users",
			table: "auth.users",
			getKey: (item) => item.id,
		}),
	);

	const agentCommands = createCollection(
		fetchCollectionOptions<SelectAgentCommand>({
			id: "agent_commands",
			table: "agent_commands",
			getKey: (item) => item.id,
			onUpdate: async ({ transaction }) => {
				const { original, changes } = transaction.mutations[0];
				const result = await electronTrpcClient.data.agent.updateCommand.mutate(
					{
						...changes,
						id: original.id,
					},
				);
				return { txid: result.txid };
			},
		}),
	);

	const devicePresence = createCollection(
		fetchCollectionOptions<SelectDevicePresence>({
			id: "device_presence",
			table: "device_presence",
			getKey: (item) => item.id,
		}),
	);

	const integrationConnections = createCollection(
		fetchCollectionOptions<IntegrationConnectionDisplay>({
			id: "integration_connections",
			table: "integration_connections",
			getKey: (item) => item.id,
		}),
	);

	const chatSessions = createCollection(
		fetchCollectionOptions<SelectChatSession>({
			id: "chat_sessions",
			table: "chat_sessions",
			getKey: (item) => item.id,
		}),
	);

	const sessionHosts = createCollection(
		fetchCollectionOptions<SelectSessionHost>({
			id: "session_hosts",
			table: "session_hosts",
			getKey: (item) => item.id,
		}),
	);

	const githubRepositories = createCollection(
		fetchCollectionOptions<SelectGithubRepository>({
			id: "github_repositories",
			table: "github_repositories",
			getKey: (item) => item.id,
		}),
	);

	const githubPullRequests = createCollection(
		fetchCollectionOptions<SelectGithubPullRequest>({
			id: "github_pull_requests",
			table: "github_pull_requests",
			getKey: (item) => item.id,
		}),
	);

	return {
		tasks,
		taskStatuses,
		projects,
		workspaces,
		users,
		agentCommands,
		devicePresence,
		integrationConnections,
		chatSessions,
		sessionHosts,
		githubRepositories,
		githubPullRequests,
	};
}

/**
 * Preload collections by starting sync.
 * Collections are lazy — they don't fetch data until subscribed or preloaded.
 */
export async function preloadCollections(): Promise<void> {
	const { chatSessions, sessionHosts, ...rest } = getCollections();
	const allCollections = [
		...Object.values(rest),
		chatSessions,
		sessionHosts,
	] as Collection<object>[];

	await Promise.allSettled(allCollections.map((c) => c.preload()));
}

/**
 * Get the singleton collections instance, creating it if needed.
 */
export function getCollections(): Collections {
	if (!collectionsInstance) {
		collectionsInstance = createCollections();
	}
	return collectionsInstance;
}
