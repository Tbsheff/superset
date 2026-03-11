import type {
	SelectAgentCommand,
	SelectChatSession,
	SelectDevicePresence,
	SelectGithubPullRequest,
	SelectGithubRepository,
	SelectIntegrationConnection,
	SelectInvitation,
	SelectMember,
	SelectOrganization,
	SelectProject,
	SelectSessionHost,
	SelectSubscription,
	SelectTask,
	SelectTaskStatus,
	SelectUser,
	SelectWorkspace,
} from "@superset/db/schema";
import type { AppRouter } from "@superset/trpc";
import type { Collection } from "@tanstack/react-db";
import { createCollection } from "@tanstack/react-db";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { env } from "renderer/env.renderer";
import { getAuthToken, getJwt } from "renderer/lib/auth-client";
import superjson from "superjson";
import { z } from "zod";

const apiKeyDisplaySchema = z.object({
	id: z.string(),
	name: z.string().nullable(),
	start: z.string().nullable(),
	createdAt: z.coerce.date(),
	lastRequest: z.coerce.date().nullable(),
});

type ApiKeyDisplay = z.infer<typeof apiKeyDisplaySchema>;

type IntegrationConnectionDisplay = Omit<
	SelectIntegrationConnection,
	"accessToken" | "refreshToken"
>;

interface OrgCollections {
	tasks: Collection<SelectTask, string>;
	taskStatuses: Collection<SelectTaskStatus, string>;
	projects: Collection<SelectProject, string>;
	workspaces: Collection<SelectWorkspace, string>;
	members: Collection<SelectMember, string>;
	users: Collection<SelectUser, string>;
	invitations: Collection<SelectInvitation, string>;
	agentCommands: Collection<SelectAgentCommand, string>;
	devicePresence: Collection<SelectDevicePresence, string>;
	integrationConnections: Collection<IntegrationConnectionDisplay, string>;
	subscriptions: Collection<SelectSubscription, string>;
	apiKeys: Collection<ApiKeyDisplay, string>;
	chatSessions: Collection<SelectChatSession, string>;
	sessionHosts: Collection<SelectSessionHost, string>;
	githubRepositories: Collection<SelectGithubRepository, string>;
	githubPullRequests: Collection<SelectGithubPullRequest, string>;
}

// Per-org collections cache
const collectionsCache = new Map<string, OrgCollections>();

// Singleton API client with dynamic auth headers
const apiClient = createTRPCProxyClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${env.NEXT_PUBLIC_API_URL}/api/trpc`,
			headers: () => {
				const token = getAuthToken();
				return token ? { Authorization: `Bearer ${token}` } : {};
			},
			transformer: superjson,
		}),
	],
});

// ---------------------------------------------------------------------------
// Fetch-based sync — replaces Electric SQL
// ---------------------------------------------------------------------------

const DATA_URL = `${env.NEXT_PUBLIC_API_URL}/api/electric/v1/shape`;
const POLL_INTERVAL = 5_000; // 5 seconds

/** Convert snake_case keys to camelCase */
function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** Convert a snake_case row from the API to camelCase for the app */
function mapRow<T>(row: Record<string, unknown>): T {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		result[snakeToCamel(key)] = value;
	}
	return result as T;
}

/** Fetch rows from the local data API */
async function fetchRows<T>(
	table: string,
	organizationId?: string,
): Promise<T[]> {
	const params = new URLSearchParams({ table });
	if (organizationId) params.set("organizationId", organizationId);

	const headers: Record<string, string> = {};
	const token = getJwt();
	if (token) headers.Authorization = `Bearer ${token}`;

	const response = await fetch(`${DATA_URL}?${params}`, { headers });
	if (!response.ok) return [];

	const raw: Record<string, unknown>[] = await response.json();
	return raw.map(mapRow<T>);
}

/**
 * Create collection options with a fetch-based sync.
 * Loads data from the local API on mount and polls for updates.
 */
function fetchCollectionOptions<T extends object>(config: {
	id: string;
	table: string;
	organizationId?: string;
	getKey: (item: T) => string;
	onInsert?: (params: {
		transaction: { mutations: Array<{ modified: T }> };
	}) => Promise<{ txid: number } | void>;
	onUpdate?: (params: {
		transaction: {
			mutations: Array<{ original: T; changes: Partial<T> }>;
		};
	}) => Promise<{ txid: number } | void>;
	onDelete?: (params: {
		transaction: { mutations: Array<{ original: T }> };
	}) => Promise<{ txid: number } | void>;
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
						const rows = await fetchRows<T>(
							config.table,
							config.organizationId,
						);
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
// Collection factories
// ---------------------------------------------------------------------------

const organizationsCollection = createCollection(
	fetchCollectionOptions<SelectOrganization>({
		id: "organizations",
		table: "auth.organizations",
		getKey: (item) => item.id,
	}),
);

function createOrgCollections(organizationId: string): OrgCollections {
	const tasks = createCollection(
		fetchCollectionOptions<SelectTask>({
			id: `tasks-${organizationId}`,
			table: "tasks",
			organizationId,
			getKey: (item) => item.id,
			onInsert: async ({ transaction }) => {
				const item = transaction.mutations[0].modified;
				const result = await apiClient.task.create.mutate(item);
				return { txid: result.txid };
			},
			onUpdate: async ({ transaction }) => {
				const { original, changes } = transaction.mutations[0];
				const result = await apiClient.task.update.mutate({
					...changes,
					id: original.id,
				});
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
		fetchCollectionOptions<SelectTaskStatus>({
			id: `task_statuses-${organizationId}`,
			table: "task_statuses",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const projects = createCollection(
		fetchCollectionOptions<SelectProject>({
			id: `projects-${organizationId}`,
			table: "projects",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const workspaces = createCollection(
		fetchCollectionOptions<SelectWorkspace>({
			id: `workspaces-${organizationId}`,
			table: "workspaces",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const members = createCollection(
		fetchCollectionOptions<SelectMember>({
			id: `members-${organizationId}`,
			table: "auth.members",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const users = createCollection(
		fetchCollectionOptions<SelectUser>({
			id: `users-${organizationId}`,
			table: "auth.users",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const invitations = createCollection(
		fetchCollectionOptions<SelectInvitation>({
			id: `invitations-${organizationId}`,
			table: "auth.invitations",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const agentCommands = createCollection(
		fetchCollectionOptions<SelectAgentCommand>({
			id: `agent_commands-${organizationId}`,
			table: "agent_commands",
			organizationId,
			getKey: (item) => item.id,
			onUpdate: async ({ transaction }) => {
				const { original, changes } = transaction.mutations[0];
				const result = await apiClient.agent.updateCommand.mutate({
					...changes,
					id: original.id,
				});
				return { txid: result.txid };
			},
		}),
	);

	const devicePresence = createCollection(
		fetchCollectionOptions<SelectDevicePresence>({
			id: `device_presence-${organizationId}`,
			table: "device_presence",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const integrationConnections = createCollection(
		fetchCollectionOptions<IntegrationConnectionDisplay>({
			id: `integration_connections-${organizationId}`,
			table: "integration_connections",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const subscriptions = createCollection(
		fetchCollectionOptions<SelectSubscription>({
			id: `subscriptions-${organizationId}`,
			table: "subscriptions",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const apiKeys = createCollection(
		fetchCollectionOptions<ApiKeyDisplay>({
			id: `apikeys-${organizationId}`,
			table: "auth.apikeys",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const chatSessions = createCollection(
		fetchCollectionOptions<SelectChatSession>({
			id: `chat_sessions-${organizationId}`,
			table: "chat_sessions",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const sessionHosts = createCollection(
		fetchCollectionOptions<SelectSessionHost>({
			id: `session_hosts-${organizationId}`,
			table: "session_hosts",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const githubRepositories = createCollection(
		fetchCollectionOptions<SelectGithubRepository>({
			id: `github_repositories-${organizationId}`,
			table: "github_repositories",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	const githubPullRequests = createCollection(
		fetchCollectionOptions<SelectGithubPullRequest>({
			id: `github_pull_requests-${organizationId}`,
			table: "github_pull_requests",
			organizationId,
			getKey: (item) => item.id,
		}),
	);

	return {
		tasks,
		taskStatuses,
		projects,
		workspaces,
		members,
		users,
		invitations,
		agentCommands,
		devicePresence,
		integrationConnections,
		subscriptions,
		apiKeys,
		chatSessions,
		sessionHosts,
		githubRepositories,
		githubPullRequests,
	};
}

/**
 * Preload collections for an organization by starting sync.
 * Collections are lazy — they don't fetch data until subscribed or preloaded.
 */
export async function preloadCollections(
	organizationId: string,
	options?: {
		includeChatCollections?: boolean;
	},
): Promise<void> {
	const { chatSessions, sessionHosts, ...collections } =
		getCollections(organizationId);
	const includeChatCollections = options?.includeChatCollections ?? true;
	const orgCollections = Object.entries(collections)
		.filter(([name]) => name !== "organizations")
		.map(([, collection]) => collection as Collection<object>);
	const collectionsToPreload = includeChatCollections
		? [...orgCollections, chatSessions, sessionHosts]
		: orgCollections;

	await Promise.allSettled(
		collectionsToPreload.map((c) => (c as Collection<object>).preload()),
	);
}

/**
 * Get collections for an organization, creating them if needed.
 * Collections are cached per org for instant switching.
 */
export function getCollections(organizationId: string) {
	if (!collectionsCache.has(organizationId)) {
		collectionsCache.set(organizationId, createOrgCollections(organizationId));
	}

	const orgCollections = collectionsCache.get(organizationId);
	if (!orgCollections) {
		throw new Error(`Collections not found for org: ${organizationId}`);
	}

	return {
		...orgCollections,
		organizations: organizationsCollection,
	};
}
