ALTER TABLE `terminal_sessions` ADD `runtime_instance_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `runtime_kind` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `current_runtime_id` text;