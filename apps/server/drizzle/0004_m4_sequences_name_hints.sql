CREATE TABLE `sequences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` text NOT NULL,
	`tier` text NOT NULL,
	`status` text NOT NULL,
	`sequence_json` text NOT NULL,
	`validation_json` text NOT NULL,
	`judge_json` text,
	`approved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sequences_lead_id_idx` ON `sequences` (`lead_id`);--> statement-breakpoint
ALTER TABLE `pages` ADD `name_hints_json` text DEFAULT '[]' NOT NULL;