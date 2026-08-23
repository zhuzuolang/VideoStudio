CREATE TABLE `agent_run_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`snapshot_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_run_sources_run` ON `agent_run_sources` (`run_id`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`model_id` text,
	`model_name` text NOT NULL,
	`prompt` text NOT NULL,
	`system_prompt` text,
	`status` text NOT NULL,
	`response` text,
	`error_message` text,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`request_meta_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `ai_models`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_project_created` ON `agent_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_owner` ON `agent_runs` (`owner_id`);--> statement-breakpoint
CREATE TABLE `ai_models` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 'OpenAI-compatible' NOT NULL,
	`model_id` text NOT NULL,
	`level` text DEFAULT 'standard' NOT NULL,
	`endpoint` text NOT NULL,
	`icon_url` text,
	`api_key_ciphertext` text,
	`api_key_iv` text,
	`api_key_hint` text,
	`enabled` integer DEFAULT true NOT NULL,
	`parameters_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_models_owner_updated` ON `ai_models` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`mime_type` text,
	`size_bytes` integer,
	`storage_key` text,
	`source_url` text,
	`thumbnail_url` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_assets_project_type` ON `assets` (`project_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_assets_storage_key` ON `assets` (`storage_key`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '配角' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`appearance` text DEFAULT '' NOT NULL,
	`personality` text DEFAULT '' NOT NULL,
	`arc` text DEFAULT '' NOT NULL,
	`voice` text DEFAULT '' NOT NULL,
	`relationships_json` text DEFAULT '[]' NOT NULL,
	`avatar_url` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_characters_project` ON `characters` (`project_id`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`episode_no` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`hook` text DEFAULT '' NOT NULL,
	`duration_seconds` integer DEFAULT 120 NOT NULL,
	`status` text DEFAULT 'outline' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_episodes_project_no` ON `episodes` (`project_id`,`episode_no`);--> statement-breakpoint
CREATE INDEX `idx_episodes_project` ON `episodes` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_story` (
	`project_id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`logline` text DEFAULT '' NOT NULL,
	`synopsis` text DEFAULT '' NOT NULL,
	`worldview` text DEFAULT '' NOT NULL,
	`core_conflict` text DEFAULT '' NOT NULL,
	`themes_json` text DEFAULT '[]' NOT NULL,
	`style_reference` text DEFAULT '' NOT NULL,
	`story_bible` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`genre` text DEFAULT '剧情' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'developing' NOT NULL,
	`episode_count` integer DEFAULT 12 NOT NULL,
	`single_episode_duration` integer DEFAULT 120 NOT NULL,
	`aspect_ratio` text DEFAULT '9:16' NOT NULL,
	`target_platform` text DEFAULT '短视频平台' NOT NULL,
	`cover_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_owner_updated` ON `projects` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`script_id` text NOT NULL,
	`scene_no` integer NOT NULL,
	`order_index` integer DEFAULT 0 NOT NULL,
	`heading` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`time_of_day` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`action` text DEFAULT '' NOT NULL,
	`dialogue_json` text DEFAULT '[]' NOT NULL,
	`characters_json` text DEFAULT '[]' NOT NULL,
	`wardrobe_json` text DEFAULT '[]' NOT NULL,
	`props_json` text DEFAULT '[]' NOT NULL,
	`duration_seconds` integer DEFAULT 30 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_scenes_script_no` ON `scenes` (`script_id`,`scene_no`);--> statement-breakpoint
CREATE INDEX `idx_scenes_project` ON `scenes` (`project_id`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`episode_id` text,
	`title` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_scripts_project` ON `scripts` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_episode` ON `scripts` (`episode_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`active_project_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
