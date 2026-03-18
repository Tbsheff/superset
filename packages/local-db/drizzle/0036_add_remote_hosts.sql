CREATE TABLE `remote_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`hostname` text,
	`port` integer DEFAULT 22,
	`username` text,
	`auth_method` text,
	`private_key_path` text,
	`default_cwd` text,
	`last_connected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `remote_hosts_type_idx` ON `remote_hosts` (`type`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `remote_host_id` text REFERENCES remote_hosts(id);