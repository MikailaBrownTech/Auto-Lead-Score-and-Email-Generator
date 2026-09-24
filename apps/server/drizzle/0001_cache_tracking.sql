ALTER TABLE `runs` ADD `cache_write_5m_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_write_1h_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `prefix_key` text;--> statement-breakpoint
CREATE INDEX `runs_prefix_key_idx` ON `runs` (`prefix_key`);