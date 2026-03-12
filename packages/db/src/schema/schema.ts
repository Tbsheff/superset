import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { users } from "./auth";
import type {
	CommandStatus,
	DeviceType,
	IntegrationProvider,
	TaskPriority,
	WorkspaceType,
} from "./enums";
import { githubRepositories } from "./github";
import type { IntegrationConfig } from "./types";
import type { WorkspaceConfig } from "./zod";

export const taskStatuses = sqliteTable(
	"task_statuses",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),

		name: text("name").notNull(),
		color: text("color").notNull(),
		type: text("type").notNull(),
		position: real("position").notNull(),
		progressPercent: real("progress_percent"),

		// External sync
		externalProvider: text("external_provider"),
		externalId: text("external_id"),

		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("task_statuses_type_idx").on(table.type),
		unique("task_statuses_external_unique").on(
			table.externalProvider,
			table.externalId,
		),
	],
);

export type InsertTaskStatus = typeof taskStatuses.$inferInsert;
export type SelectTaskStatus = typeof taskStatuses.$inferSelect;

export const tasks = sqliteTable(
	"tasks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),

		// Core fields
		slug: text("slug").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		statusId: text("status_id")
			.notNull()
			.references(() => taskStatuses.id),
		priority: text("priority").notNull().default("none").$type<TaskPriority>(),

		// Ownership
		assigneeId: text("assignee_id").references(() => users.id, {
			onDelete: "set null",
		}),
		creatorId: text("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),

		// Planning
		estimate: integer("estimate"),
		dueDate: integer("due_date", { mode: "timestamp" }),
		labels: text("labels", { mode: "json" }).$type<string[]>().default([]),

		// Git/Work tracking
		branch: text("branch"),
		prUrl: text("pr_url"),

		// External sync
		externalProvider: text("external_provider"),
		externalId: text("external_id"),
		externalKey: text("external_key"),
		externalUrl: text("external_url"),
		lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
		syncError: text("sync_error"),

		// External assignee snapshot
		assigneeExternalId: text("assignee_external_id"),
		assigneeDisplayName: text("assignee_display_name"),
		assigneeAvatarUrl: text("assignee_avatar_url"),

		startedAt: integer("started_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		deletedAt: integer("deleted_at", { mode: "timestamp" }),

		// Timestamps
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("tasks_slug_idx").on(table.slug),
		index("tasks_assignee_id_idx").on(table.assigneeId),
		index("tasks_creator_id_idx").on(table.creatorId),
		index("tasks_status_id_idx").on(table.statusId),
		index("tasks_created_at_idx").on(table.createdAt),
		index("tasks_external_provider_idx").on(table.externalProvider),
		index("tasks_assignee_external_id_idx").on(table.assigneeExternalId),
		unique("tasks_external_unique").on(
			table.externalProvider,
			table.externalId,
		),
		unique("tasks_slug_unique").on(table.slug),
	],
);

export type InsertTask = typeof tasks.$inferInsert;
export type SelectTask = typeof tasks.$inferSelect;

export const integrationConnections = sqliteTable(
	"integration_connections",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		connectedByUserId: text("connected_by_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),

		provider: text("provider").notNull().$type<IntegrationProvider>(),

		// OAuth tokens
		accessToken: text("access_token").notNull(),
		refreshToken: text("refresh_token"),
		tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }),

		externalOrgId: text("external_org_id"),
		externalOrgName: text("external_org_name"),

		config: text("config", { mode: "json" }).$type<IntegrationConfig>(),

		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [unique("integration_connections_unique").on(table.provider)],
);

export type InsertIntegrationConnection =
	typeof integrationConnections.$inferInsert;
export type SelectIntegrationConnection =
	typeof integrationConnections.$inferSelect;

export const devicePresence = sqliteTable(
	"device_presence",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		deviceId: text("device_id").notNull(),
		deviceName: text("device_name").notNull(),
		deviceType: text("device_type").notNull().$type<DeviceType>(),
		lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("device_presence_user_idx").on(table.userId),
		uniqueIndex("device_presence_user_device_idx").on(
			table.userId,
			table.deviceId,
		),
		index("device_presence_last_seen_idx").on(table.lastSeenAt),
	],
);

export type InsertDevicePresence = typeof devicePresence.$inferInsert;
export type SelectDevicePresence = typeof devicePresence.$inferSelect;

export const agentCommands = sqliteTable(
	"agent_commands",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		targetDeviceId: text("target_device_id"),
		targetDeviceType: text("target_device_type"),
		tool: text("tool").notNull(),
		params: text("params", { mode: "json" }).$type<Record<string, unknown>>(),
		parentCommandId: text("parent_command_id"),
		status: text("status").notNull().default("pending").$type<CommandStatus>(),
		result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
		error: text("error"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		executedAt: integer("executed_at", { mode: "timestamp" }),
		timeoutAt: integer("timeout_at", { mode: "timestamp" }),
	},
	(table) => [
		index("agent_commands_user_status_idx").on(table.userId, table.status),
		index("agent_commands_target_device_status_idx").on(
			table.targetDeviceId,
			table.status,
		),
		index("agent_commands_created_idx").on(table.createdAt),
	],
);

export type InsertAgentCommand = typeof agentCommands.$inferInsert;
export type SelectAgentCommand = typeof agentCommands.$inferSelect;

export const usersSlackUsers = sqliteTable(
	"users__slack_users",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		slackUserId: text("slack_user_id").notNull(),
		teamId: text("team_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		modelPreference: text("model_preference"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		unique("users__slack_users_unique").on(table.slackUserId, table.teamId),
		index("users__slack_users_user_idx").on(table.userId),
	],
);

export type InsertUsersSlackUsers = typeof usersSlackUsers.$inferInsert;
export type SelectUsersSlackUsers = typeof usersSlackUsers.$inferSelect;

export const projects = sqliteTable(
	"projects",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		githubRepositoryId: text("github_repository_id").references(
			() => githubRepositories.id,
			{ onDelete: "set null" },
		),
		repoOwner: text("repo_owner").notNull(),
		repoName: text("repo_name").notNull(),
		repoUrl: text("repo_url").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [unique("projects_slug_unique").on(table.slug)],
);

export type InsertProject = typeof projects.$inferInsert;
export type SelectProject = typeof projects.$inferSelect;

export const secrets = sqliteTable(
	"secrets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		encryptedValue: text("encrypted_value").notNull(),
		sensitive: integer("sensitive", { mode: "boolean" })
			.notNull()
			.default(false),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [
		unique("secrets_project_key_unique").on(table.projectId, table.key),
		index("secrets_project_id_idx").on(table.projectId),
	],
);

export type InsertSecret = typeof secrets.$inferInsert;
export type SelectSecret = typeof secrets.$inferSelect;

export const sandboxImages = sqliteTable(
	"sandbox_images",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		setupCommands: text("setup_commands", { mode: "json" })
			.$type<string[]>()
			.default([]),
		baseImage: text("base_image"),
		systemPackages: text("system_packages", { mode: "json" })
			.$type<string[]>()
			.default([]),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [unique("sandbox_images_project_unique").on(table.projectId)],
);

export type InsertSandboxImage = typeof sandboxImages.$inferInsert;
export type SelectSandboxImage = typeof sandboxImages.$inferSelect;

export const workspaces = sqliteTable(
	"workspaces",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		type: text("type").notNull().$type<WorkspaceType>(),
		config: text("config", { mode: "json" }).notNull().$type<WorkspaceConfig>(),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("workspaces_project_id_idx").on(table.projectId),
		index("workspaces_type_idx").on(table.type),
	],
);

export type InsertWorkspace = typeof workspaces.$inferInsert;
export type SelectWorkspace = typeof workspaces.$inferSelect;

export const chatSessions = sqliteTable(
	"chat_sessions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		title: text("title"),
		lastActiveAt: integer("last_active_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("chat_sessions_created_by_idx").on(table.createdBy),
		index("chat_sessions_last_active_idx").on(table.lastActiveAt),
	],
);

export type InsertChatSession = typeof chatSessions.$inferInsert;
export type SelectChatSession = typeof chatSessions.$inferSelect;

export const sessionHosts = sqliteTable(
	"session_hosts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: text("session_id")
			.notNull()
			.references(() => chatSessions.id, { onDelete: "cascade" }),
		deviceId: text("device_id").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("session_hosts_session_id_idx").on(table.sessionId),
		index("session_hosts_device_id_idx").on(table.deviceId),
	],
);

export type InsertSessionHost = typeof sessionHosts.$inferInsert;
export type SelectSessionHost = typeof sessionHosts.$inferSelect;
