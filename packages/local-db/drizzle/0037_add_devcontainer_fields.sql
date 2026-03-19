ALTER TABLE `projects` ADD `remote_host_id` text REFERENCES remote_hosts(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `sandbox_state` text;--> statement-breakpoint
ALTER TABLE `remote_hosts` ADD `docker_memory_limit` text;--> statement-breakpoint
ALTER TABLE `remote_hosts` ADD `docker_cpu_limit` integer;--> statement-breakpoint
ALTER TABLE `remote_hosts` ADD `idle_timeout_minutes` integer;