CREATE TABLE `asset_generation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`model_id` text,
	`model_name` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`prompt` text NOT NULL,
	`size` text,
	`aspect_ratio` text,
	`relations_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`error_code` text,
	`error_message` text,
	`retryable` integer DEFAULT true NOT NULL,
	`asset_id` text,
	`storage_key` text,
	`dismissed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `ai_models`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_asset_generation_client_request` ON `asset_generation_jobs` (`project_id`,`owner_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_asset_generation_project_updated` ON `asset_generation_jobs` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_asset_generation_status_lease` ON `asset_generation_jobs` (`status`,`lease_expires_at`);