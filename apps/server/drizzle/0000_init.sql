CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`model` text NOT NULL,
	`call_type` text NOT NULL,
	`lead_id` text,
	`status` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`stop_reason` text,
	`message_id` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `runs_created_at_idx` ON `runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `runs_lead_id_idx` ON `runs` (`lead_id`);