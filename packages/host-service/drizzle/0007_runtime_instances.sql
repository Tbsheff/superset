CREATE TABLE `runtime_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`role` text DEFAULT 'workspace' NOT NULL,
	`external_id` text,
	`status` text NOT NULL,
	`preview_url` text,
	`last_activity_at` integer,
	`ttl_expires_at` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`destroyed_at` integer,
	`failure_reason` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runtime_instances_workspace_id_idx` ON `runtime_instances` (`workspace_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_workspace_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`runtime_instance_id` text,
	`created_at` integer NOT NULL,
	`last_attached_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`origin_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`runtime_instance_id`) REFERENCES `runtime_instances`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_terminal_sessions`("id", "origin_workspace_id", "status", "runtime_instance_id", "created_at", "last_attached_at", "ended_at") SELECT "id", "origin_workspace_id", "status", "runtime_instance_id", "created_at", "last_attached_at", "ended_at" FROM `terminal_sessions`;--> statement-breakpoint
DROP TABLE `terminal_sessions`;--> statement-breakpoint
ALTER TABLE `__new_terminal_sessions` RENAME TO `terminal_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `terminal_sessions_origin_workspace_id_idx` ON `terminal_sessions` (`origin_workspace_id`);--> statement-breakpoint
CREATE INDEX `terminal_sessions_status_idx` ON `terminal_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `__new_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`head_sha` text,
	`upstream_owner` text,
	`upstream_repo` text,
	`upstream_branch` text,
	`pull_request_id` text,
	`runtime_kind` text DEFAULT 'local' NOT NULL,
	`current_runtime_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`current_runtime_id`) REFERENCES `runtime_instances`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_workspaces`("id", "project_id", "worktree_path", "branch", "head_sha", "upstream_owner", "upstream_repo", "upstream_branch", "pull_request_id", "runtime_kind", "current_runtime_id", "created_at") SELECT "id", "project_id", "worktree_path", "branch", "head_sha", "upstream_owner", "upstream_repo", "upstream_branch", "pull_request_id", "runtime_kind", "current_runtime_id", "created_at" FROM `workspaces`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;--> statement-breakpoint
CREATE INDEX `workspaces_project_id_idx` ON `workspaces` (`project_id`);--> statement-breakpoint
CREATE INDEX `workspaces_upstream_ref_idx` ON `workspaces` (`upstream_owner`,`upstream_repo`,`upstream_branch`);--> statement-breakpoint
CREATE INDEX `workspaces_pull_request_id_idx` ON `workspaces` (`pull_request_id`);