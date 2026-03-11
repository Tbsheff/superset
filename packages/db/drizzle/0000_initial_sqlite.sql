CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_apikeys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`start` text,
	`prefix` text,
	`key` text NOT NULL,
	`user_id` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer DEFAULT 86400000,
	`rate_limit_max` integer DEFAULT 10,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `apikeys_key_idx` ON `auth_apikeys` (`key`);--> statement-breakpoint
CREATE INDEX `apikeys_user_id_idx` ON `auth_apikeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitations_organization_id_idx` ON `auth_invitations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `auth_invitations` (`email`);--> statement-breakpoint
CREATE TABLE `auth_jwkss` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `auth_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `members_organization_id_idx` ON `auth_members` (`organization_id`);--> statement-breakpoint
CREATE INDEX `members_user_id_idx` ON `auth_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`refresh_id` text,
	`expires_at` integer,
	`created_at` integer,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `auth_oauth_refresh_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_access_tokens_token_unique` ON `auth_oauth_access_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `auth_oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`disabled` integer DEFAULT false,
	`skip_consent` integer,
	`enable_end_session` integer,
	`scopes` text,
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`token_endpoint_auth_method` text,
	`grant_types` text,
	`response_types` text,
	`public` integer,
	`type` text,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_clients_client_id_unique` ON `auth_oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`scopes` text NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`expires_at` integer,
	`created_at` integer,
	`revoked` integer,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `auth_oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text,
	`stripe_customer_id` text,
	`allowed_domains` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_organizations_slug_unique` ON `auth_organizations` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_idx` ON `auth_organizations` (`slug`);--> statement-breakpoint
CREATE INDEX `organizations_allowed_domains_idx` ON `auth_organizations` (`allowed_domains`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_unique` ON `auth_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`organization_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `auth_verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`permissions` text,
	`suspended` integer DEFAULT false NOT NULL,
	`suspended_at` integer,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by_user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_installation_id_unique` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE INDEX `github_installations_installation_id_idx` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_org_unique` ON `github_installations` (`organization_id`);--> statement-breakpoint
CREATE TABLE `github_pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`node_id` text NOT NULL,
	`head_branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_branch` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`author_login` text NOT NULL,
	`author_avatar_url` text,
	`state` text NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`changed_files` integer DEFAULT 0 NOT NULL,
	`review_decision` text,
	`checks_status` text DEFAULT 'none' NOT NULL,
	`checks` text DEFAULT '[]',
	`merged_at` integer,
	`closed_at` integer,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `github_repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `github_pull_requests_repository_id_idx` ON `github_pull_requests` (`repository_id`);--> statement-breakpoint
CREATE INDEX `github_pull_requests_state_idx` ON `github_pull_requests` (`state`);--> statement-breakpoint
CREATE INDEX `github_pull_requests_head_branch_idx` ON `github_pull_requests` (`head_branch`);--> statement-breakpoint
CREATE INDEX `github_pull_requests_org_id_idx` ON `github_pull_requests` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_pull_requests_repo_pr_unique` ON `github_pull_requests` (`repository_id`,`pr_number`);--> statement-breakpoint
CREATE TABLE `github_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_repositories_repo_id_unique` ON `github_repositories` (`repo_id`);--> statement-breakpoint
CREATE INDEX `github_repositories_installation_id_idx` ON `github_repositories` (`installation_id`);--> statement-breakpoint
CREATE INDEX `github_repositories_full_name_idx` ON `github_repositories` (`full_name`);--> statement-breakpoint
CREATE INDEX `github_repositories_org_id_idx` ON `github_repositories` (`organization_id`);--> statement-breakpoint
CREATE TABLE `ingest_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`processed_at` integer,
	`error` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_events_provider_status_idx` ON `ingest_webhook_events` (`provider`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_provider_event_id_idx` ON `ingest_webhook_events` (`provider`,`event_id`);--> statement-breakpoint
CREATE INDEX `webhook_events_received_at_idx` ON `ingest_webhook_events` (`received_at`);--> statement-breakpoint
CREATE TABLE `agent_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`target_device_id` text,
	`target_device_type` text,
	`tool` text NOT NULL,
	`params` text,
	`parent_command_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`executed_at` integer,
	`timeout_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_commands_user_status_idx` ON `agent_commands` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_commands_target_device_status_idx` ON `agent_commands` (`target_device_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_commands_org_created_idx` ON `agent_commands` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_by` text NOT NULL,
	`workspace_id` text,
	`title` text,
	`last_active_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chat_sessions_org_idx` ON `chat_sessions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `chat_sessions_created_by_idx` ON `chat_sessions` (`created_by`);--> statement-breakpoint
CREATE INDEX `chat_sessions_last_active_idx` ON `chat_sessions` (`last_active_at`);--> statement-breakpoint
CREATE TABLE `device_presence` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`device_name` text NOT NULL,
	`device_type` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_presence_user_org_idx` ON `device_presence` (`user_id`,`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_presence_user_device_idx` ON `device_presence` (`user_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `device_presence_last_seen_idx` ON `device_presence` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`token_expires_at` integer,
	`external_org_id` text,
	`external_org_name` text,
	`config` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by_user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `integration_connections_org_idx` ON `integration_connections` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_unique` ON `integration_connections` (`organization_id`,`provider`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`github_repository_id` text,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`repo_url` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`github_repository_id`) REFERENCES `github_repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `projects_organization_id_idx` ON `projects` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_slug_unique` ON `projects` (`organization_id`,`slug`);--> statement-breakpoint
CREATE TABLE `sandbox_images` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`setup_commands` text DEFAULT '[]',
	`base_image` text,
	`system_packages` text DEFAULT '[]',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sandbox_images_organization_id_idx` ON `sandbox_images` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_images_project_unique` ON `sandbox_images` (`project_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `secrets_project_id_idx` ON `secrets` (`project_id`);--> statement-breakpoint
CREATE INDEX `secrets_organization_id_idx` ON `secrets` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_project_key_unique` ON `secrets` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `session_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_hosts_session_id_idx` ON `session_hosts` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_hosts_org_idx` ON `session_hosts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `session_hosts_device_id_idx` ON `session_hosts` (`device_id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`reference_id` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`status` text DEFAULT 'incomplete' NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`trial_start` integer,
	`trial_end` integer,
	`cancel_at_period_end` integer DEFAULT false,
	`cancel_at` integer,
	`canceled_at` integer,
	`ended_at` integer,
	`seats` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`reference_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscriptions_reference_id_idx` ON `subscriptions` (`reference_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_stripe_customer_id_idx` ON `subscriptions` (`stripe_customer_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_status_idx` ON `subscriptions` (`status`);--> statement-breakpoint
CREATE TABLE `task_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`type` text NOT NULL,
	`position` real NOT NULL,
	`progress_percent` real,
	`external_provider` text,
	`external_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_statuses_organization_id_idx` ON `task_statuses` (`organization_id`);--> statement-breakpoint
CREATE INDEX `task_statuses_type_idx` ON `task_statuses` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_statuses_org_external_unique` ON `task_statuses` (`organization_id`,`external_provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status_id` text NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`organization_id` text NOT NULL,
	`assignee_id` text,
	`creator_id` text NOT NULL,
	`estimate` integer,
	`due_date` integer,
	`labels` text DEFAULT '[]',
	`branch` text,
	`pr_url` text,
	`external_provider` text,
	`external_id` text,
	`external_key` text,
	`external_url` text,
	`last_synced_at` integer,
	`sync_error` text,
	`assignee_external_id` text,
	`assignee_display_name` text,
	`assignee_avatar_url` text,
	`started_at` integer,
	`completed_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`status_id`) REFERENCES `task_statuses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`creator_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_slug_idx` ON `tasks` (`slug`);--> statement-breakpoint
CREATE INDEX `tasks_organization_id_idx` ON `tasks` (`organization_id`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_id_idx` ON `tasks` (`assignee_id`);--> statement-breakpoint
CREATE INDEX `tasks_creator_id_idx` ON `tasks` (`creator_id`);--> statement-breakpoint
CREATE INDEX `tasks_status_id_idx` ON `tasks` (`status_id`);--> statement-breakpoint
CREATE INDEX `tasks_created_at_idx` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_external_provider_idx` ON `tasks` (`external_provider`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_external_id_idx` ON `tasks` (`assignee_external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_external_unique` ON `tasks` (`organization_id`,`external_provider`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_org_slug_unique` ON `tasks` (`organization_id`,`slug`);--> statement-breakpoint
CREATE TABLE `users__slack_users` (
	`id` text PRIMARY KEY NOT NULL,
	`slack_user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`model_preference` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `users__slack_users_user_idx` ON `users__slack_users` (`user_id`);--> statement-breakpoint
CREATE INDEX `users__slack_users_org_idx` ON `users__slack_users` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users__slack_users_unique` ON `users__slack_users` (`slack_user_id`,`team_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `auth_organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workspaces_project_id_idx` ON `workspaces` (`project_id`);--> statement-breakpoint
CREATE INDEX `workspaces_organization_id_idx` ON `workspaces` (`organization_id`);--> statement-breakpoint
CREATE INDEX `workspaces_type_idx` ON `workspaces` (`type`);