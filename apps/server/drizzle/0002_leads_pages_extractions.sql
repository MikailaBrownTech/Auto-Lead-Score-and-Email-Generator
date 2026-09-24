CREATE TABLE `extractions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` text NOT NULL,
	`cache_key` text NOT NULL,
	`model` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `extractions_cache_key_idx` ON `extractions` (`cache_key`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`input_url` text,
	`source` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`dossier_json` text,
	`score` integer,
	`tier` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requested_url` text NOT NULL,
	`url` text NOT NULL,
	`content_type` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`hidden_text` text NOT NULL,
	`links_json` text NOT NULL,
	`text_sha256` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`truncated` integer NOT NULL,
	`near_empty` integer NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pages_requested_url_idx` ON `pages` (`requested_url`);--> statement-breakpoint
CREATE INDEX `pages_url_hash_idx` ON `pages` (`url`,`raw_sha256`);--> statement-breakpoint
CREATE TABLE `robots_txt` (
	`origin` text PRIMARY KEY NOT NULL,
	`status` integer NOT NULL,
	`body` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token_counts` (
	`text_sha256` text NOT NULL,
	`model` text NOT NULL,
	`tokens` integer NOT NULL,
	PRIMARY KEY(`text_sha256`, `model`)
);
