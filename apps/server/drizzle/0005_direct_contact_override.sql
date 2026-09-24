CREATE TABLE `lead_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lead_events_lead_id_idx` ON `lead_events` (`lead_id`);--> statement-breakpoint
ALTER TABLE `leads` ADD `direct_contact_override_reason` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `direct_contact_override_at` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `incomplete_data` integer DEFAULT false NOT NULL;