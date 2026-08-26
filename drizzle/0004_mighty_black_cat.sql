ALTER TABLE `asset_generation_jobs` ADD `media_type` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `asset_generation_jobs` ADD `options_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `asset_generation_jobs` ADD `provider_task_id` text;--> statement-breakpoint
ALTER TABLE `asset_generation_jobs` ADD `next_poll_at` text;