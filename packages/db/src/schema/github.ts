import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

import { organizations, users } from "./auth";

/**
 * GitHub App installations linked to Superset organizations.
 * One organization can have one GitHub installation.
 */
export const githubInstallations = sqliteTable(
	"github_installations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),

		// Link to Superset organization
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		connectedByUserId: text("connected_by_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),

		// GitHub installation info
		installationId: text("installation_id").notNull().unique(),
		accountLogin: text("account_login").notNull(),
		accountType: text("account_type").notNull(),

		// Permissions granted to the app
		permissions: text("permissions", { mode: "json" }).$type<
			Record<string, string>
		>(),

		// Suspension state
		suspended: integer("suspended", { mode: "boolean" })
			.notNull()
			.default(false),
		suspendedAt: integer("suspended_at", { mode: "timestamp" }),

		// Sync tracking
		lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),

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
		unique("github_installations_org_unique").on(table.organizationId),
		index("github_installations_installation_id_idx").on(table.installationId),
	],
);

export type InsertGithubInstallation = typeof githubInstallations.$inferInsert;
export type SelectGithubInstallation = typeof githubInstallations.$inferSelect;

/**
 * GitHub repositories accessible via an installation.
 */
export const githubRepositories = sqliteTable(
	"github_repositories",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),

		// Link to installation
		installationId: text("installation_id")
			.notNull()
			.references(() => githubInstallations.id, { onDelete: "cascade" }),

		// Link to organization
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// GitHub repo info
		repoId: text("repo_id").notNull().unique(),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		fullName: text("full_name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		isPrivate: integer("is_private", { mode: "boolean" })
			.notNull()
			.default(false),

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
		index("github_repositories_installation_id_idx").on(table.installationId),
		index("github_repositories_full_name_idx").on(table.fullName),
		index("github_repositories_org_id_idx").on(table.organizationId),
	],
);

export type InsertGithubRepository = typeof githubRepositories.$inferInsert;
export type SelectGithubRepository = typeof githubRepositories.$inferSelect;

/**
 * GitHub pull requests tracked for synced repositories.
 */
export const githubPullRequests = sqliteTable(
	"github_pull_requests",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),

		// Link to repository
		repositoryId: text("repository_id")
			.notNull()
			.references(() => githubRepositories.id, { onDelete: "cascade" }),

		// Link to organization
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// PR identification
		prNumber: integer("pr_number").notNull(),
		nodeId: text("node_id").notNull(),

		// Branch info
		headBranch: text("head_branch").notNull(),
		headSha: text("head_sha").notNull(),
		baseBranch: text("base_branch").notNull(),

		// PR details
		title: text("title").notNull(),
		url: text("url").notNull(),
		authorLogin: text("author_login").notNull(),
		authorAvatarUrl: text("author_avatar_url"),

		// PR state
		state: text("state").notNull(),
		isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),

		// Stats
		additions: integer("additions").notNull().default(0),
		deletions: integer("deletions").notNull().default(0),
		changedFiles: integer("changed_files").notNull().default(0),

		// Review status
		reviewDecision: text("review_decision"),

		// CI/CD checks
		checksStatus: text("checks_status").notNull().default("none"),
		checks: text("checks", { mode: "json" })
			.$type<
				Array<{
					name: string;
					status: string;
					conclusion: string | null;
					detailsUrl?: string;
				}>
			>()
			.default([]),

		// Important timestamps
		mergedAt: integer("merged_at", { mode: "timestamp" }),
		closedAt: integer("closed_at", { mode: "timestamp" }),
		lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),

		// Record timestamps
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table) => [
		unique("github_pull_requests_repo_pr_unique").on(
			table.repositoryId,
			table.prNumber,
		),
		index("github_pull_requests_repository_id_idx").on(table.repositoryId),
		index("github_pull_requests_state_idx").on(table.state),
		index("github_pull_requests_head_branch_idx").on(table.headBranch),
		index("github_pull_requests_org_id_idx").on(table.organizationId),
	],
);

export type InsertGithubPullRequest = typeof githubPullRequests.$inferInsert;
export type SelectGithubPullRequest = typeof githubPullRequests.$inferSelect;
