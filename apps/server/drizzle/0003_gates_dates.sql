ALTER TABLE `leads` ADD `gate_status` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `gate_reasons_json` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `gate_approved` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pages` ADD `dates_json` text DEFAULT '[]' NOT NULL;