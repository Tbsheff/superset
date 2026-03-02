import type {
	SelectAgentCommand,
	SelectDevicePresence,
	SelectIntegrationConnection,
	SelectInvitation,
	SelectMember,
	SelectOrganization,
	SelectProject,
	SelectSubscription,
	SelectTask,
	SelectTaskStatus,
	SelectUser,
} from "@superset/db/schema";
import type { Collection } from "@tanstack/react-db";
import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import { z } from "zod";

const apiKeyDisplaySchema = z.object({
	id: z.string(),
	name: z.string().nullable(),
	start: z.string().nullable(),
	createdAt: z.coerce.date(),
	lastRequest: z.coerce.date().nullable(),
});

type ApiKeyDisplay = z.infer<typeof apiKeyDisplaySchema>;

interface OrgCollections {
	tasks: Collection<SelectTask>;
	taskStatuses: Collection<SelectTaskStatus>;
	projects: Collection<SelectProject>;
	members: Collection<SelectMember>;
	users: Collection<SelectUser>;
	invitations: Collection<SelectInvitation>;
	agentCommands: Collection<SelectAgentCommand>;
	devicePresence: Collection<SelectDevicePresence>;
	integrationConnections: Collection<SelectIntegrationConnection>;
	subscriptions: Collection<SelectSubscription>;
	apiKeys: Collection<ApiKeyDisplay>;
}

// Per-org collections cache
const collectionsCache = new Map<string, OrgCollections>();

const organizationsCollection = createCollection(
	localOnlyCollectionOptions<SelectOrganization>({
		id: "organizations",
		getKey: (item) => item.id,
	}),
);

function createOrgCollections(organizationId: string): OrgCollections {
	const tasks = createCollection(
		localOnlyCollectionOptions<SelectTask>({
			id: `tasks-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const taskStatuses = createCollection(
		localOnlyCollectionOptions<SelectTaskStatus>({
			id: `task_statuses-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const projects = createCollection(
		localOnlyCollectionOptions<SelectProject>({
			id: `projects-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const members = createCollection(
		localOnlyCollectionOptions<SelectMember>({
			id: `members-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const users = createCollection(
		localOnlyCollectionOptions<SelectUser>({
			id: `users-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const invitations = createCollection(
		localOnlyCollectionOptions<SelectInvitation>({
			id: `invitations-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const agentCommands = createCollection(
		localOnlyCollectionOptions<SelectAgentCommand>({
			id: `agent_commands-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const devicePresence = createCollection(
		localOnlyCollectionOptions<SelectDevicePresence>({
			id: `device_presence-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const integrationConnections = createCollection(
		localOnlyCollectionOptions<SelectIntegrationConnection>({
			id: `integration_connections-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const subscriptions = createCollection(
		localOnlyCollectionOptions<SelectSubscription>({
			id: `subscriptions-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	const apiKeys = createCollection(
		localOnlyCollectionOptions<ApiKeyDisplay>({
			id: `apikeys-${organizationId}`,
			getKey: (item) => item.id,
		}),
	);

	return {
		tasks,
		taskStatuses,
		projects,
		members,
		users,
		invitations,
		agentCommands,
		devicePresence,
		integrationConnections,
		subscriptions,
		apiKeys,
	};
}

/**
 * Preload collections (no-op for local-only collections).
 */
export async function preloadCollections(
	_organizationId: string,
): Promise<void> {}

/**
 * Get collections for an organization, creating them if needed.
 * Collections are cached per org.
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
