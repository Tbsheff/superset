import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("auth_users", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" })
		.default(false)
		.notNull(),
	image: text("image"),
	organizationIds: text("organization_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.$defaultFn(() => new Date())
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.$defaultFn(() => new Date())
		.$onUpdate(() => new Date())
		.notNull(),
});

export type SelectUser = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const sessions = sqliteTable(
	"auth_sessions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		token: text("token").notNull().unique(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.$onUpdate(() => new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		activeOrganizationId: text("active_organization_id"),
	},
	(table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const accounts = sqliteTable(
	"auth_accounts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", {
			mode: "timestamp",
		}),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", {
			mode: "timestamp",
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("accounts_user_id_idx").on(table.userId)],
);

export const verifications = sqliteTable(
	"auth_verifications",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const organizations = sqliteTable(
	"auth_organizations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		logo: text("logo"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.$defaultFn(() => new Date())
			.notNull(),
		metadata: text("metadata"),
		stripeCustomerId: text("stripe_customer_id"),
		allowedDomains: text("allowed_domains", { mode: "json" })
			.$type<string[]>()
			.default([])
			.notNull(),
	},
	(table) => [
		uniqueIndex("organizations_slug_idx").on(table.slug),
		index("organizations_allowed_domains_idx").on(table.allowedDomains),
	],
);

export type SelectOrganization = typeof organizations.$inferSelect;
export type InsertOrganization = typeof organizations.$inferInsert;

export const members = sqliteTable(
	"auth_members",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").default("member").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index("members_organization_id_idx").on(table.organizationId),
		index("members_user_id_idx").on(table.userId),
	],
);

export type SelectMember = typeof members.$inferSelect;
export type InsertMember = typeof members.$inferInsert;

export const invitations = sqliteTable(
	"auth_invitations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role"),
		status: text("status").default("pending").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.$defaultFn(() => new Date())
			.notNull(),
		inviterId: text("inviter_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("invitations_organization_id_idx").on(table.organizationId),
		index("invitations_email_idx").on(table.email),
	],
);

export type SelectInvitation = typeof invitations.$inferSelect;
export type InsertInvitation = typeof invitations.$inferInsert;

export const oauthClients = sqliteTable("auth_oauth_clients", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	clientId: text("client_id").notNull().unique(),
	clientSecret: text("client_secret"),
	disabled: integer("disabled", { mode: "boolean" }).default(false),
	skipConsent: integer("skip_consent", { mode: "boolean" }),
	enableEndSession: integer("enable_end_session", { mode: "boolean" }),
	scopes: text("scopes", { mode: "json" }).$type<string[]>(),
	userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
	createdAt: integer("created_at", { mode: "timestamp" }),
	updatedAt: integer("updated_at", { mode: "timestamp" }),
	name: text("name"),
	uri: text("uri"),
	icon: text("icon"),
	contacts: text("contacts", { mode: "json" }).$type<string[]>(),
	tos: text("tos"),
	policy: text("policy"),
	softwareId: text("software_id"),
	softwareVersion: text("software_version"),
	softwareStatement: text("software_statement"),
	redirectUris: text("redirect_uris", { mode: "json" })
		.$type<string[]>()
		.notNull(),
	postLogoutRedirectUris: text("post_logout_redirect_uris", {
		mode: "json",
	}).$type<string[]>(),
	tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
	grantTypes: text("grant_types", { mode: "json" }).$type<string[]>(),
	responseTypes: text("response_types", { mode: "json" }).$type<string[]>(),
	public: integer("public", { mode: "boolean" }),
	type: text("type"),
	referenceId: text("reference_id"),
	metadata: text("metadata", { mode: "json" }),
});

export const oauthRefreshTokens = sqliteTable("auth_oauth_refresh_tokens", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	token: text("token").notNull(),
	clientId: text("client_id")
		.notNull()
		.references(() => oauthClients.clientId, { onDelete: "cascade" }),
	sessionId: text("session_id").references(() => sessions.id, {
		onDelete: "set null",
	}),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	referenceId: text("reference_id"),
	expiresAt: integer("expires_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" }),
	revoked: integer("revoked", { mode: "timestamp" }),
	scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
});

export const oauthAccessTokens = sqliteTable("auth_oauth_access_tokens", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	token: text("token").unique(),
	clientId: text("client_id")
		.notNull()
		.references(() => oauthClients.clientId, { onDelete: "cascade" }),
	sessionId: text("session_id").references(() => sessions.id, {
		onDelete: "set null",
	}),
	userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
	referenceId: text("reference_id"),
	refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {
		onDelete: "cascade",
	}),
	expiresAt: integer("expires_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" }),
	scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
});

export const oauthConsents = sqliteTable("auth_oauth_consents", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	clientId: text("client_id")
		.notNull()
		.references(() => oauthClients.clientId, { onDelete: "cascade" }),
	userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
	referenceId: text("reference_id"),
	scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }),
	updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const apikeys = sqliteTable(
	"auth_apikeys",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: text("name"),
		start: text("start"),
		prefix: text("prefix"),
		key: text("key").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		refillInterval: integer("refill_interval"),
		refillAmount: integer("refill_amount"),
		lastRefillAt: integer("last_refill_at", { mode: "timestamp" }),
		enabled: integer("enabled", { mode: "boolean" }).default(true),
		rateLimitEnabled: integer("rate_limit_enabled", {
			mode: "boolean",
		}).default(true),
		rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
		rateLimitMax: integer("rate_limit_max").default(10),
		requestCount: integer("request_count").default(0),
		remaining: integer("remaining"),
		lastRequest: integer("last_request", { mode: "timestamp" }),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
		permissions: text("permissions"),
		metadata: text("metadata"),
	},
	(table) => [
		index("apikeys_key_idx").on(table.key),
		index("apikeys_user_id_idx").on(table.userId),
	],
);

export type SelectApikey = typeof apikeys.$inferSelect;
export type InsertApikey = typeof apikeys.$inferInsert;

export const jwkss = sqliteTable("auth_jwkss", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	publicKey: text("public_key").notNull(),
	privateKey: text("private_key").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.$defaultFn(() => new Date())
		.notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp" }),
});
