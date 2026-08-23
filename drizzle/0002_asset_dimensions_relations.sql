CREATE TABLE `asset_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_asset_id` text NOT NULL,
	`target_asset_id` text,
	`target_character_id` text,
	`relation_type` text DEFAULT 'related' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "asset_relations_target_xor" CHECK(("asset_relations"."target_asset_id" IS NOT NULL) != ("asset_relations"."target_character_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_asset_relations_project` ON `asset_relations` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_asset_relations_source` ON `asset_relations` (`source_asset_id`);--> statement-breakpoint
CREATE INDEX `idx_asset_relations_target_asset` ON `asset_relations` (`target_asset_id`);--> statement-breakpoint
CREATE INDEX `idx_asset_relations_target_character` ON `asset_relations` (`target_character_id`);--> statement-breakpoint
DROP INDEX `idx_assets_project_type`;--> statement-breakpoint
ALTER TABLE `assets` ADD `media_type` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `assets` ADD `category` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
UPDATE `assets` SET
  `media_type` = CASE
    WHEN `type` IN ('image', 'video', 'audio', 'model3d', 'document') THEN `type`
    WHEN `mime_type` LIKE 'image/%' THEN 'image'
    WHEN `mime_type` LIKE 'video/%' THEN 'video'
    WHEN `mime_type` LIKE 'audio/%' THEN 'audio'
    WHEN `mime_type` LIKE 'model/%' THEN 'model3d'
    WHEN `mime_type` LIKE 'text/%' OR `mime_type` LIKE '%pdf%' THEN 'document'
    ELSE 'other'
  END,
  `category` = CASE WHEN `type` IN ('character', 'costume', 'prop', 'scene') THEN `type` ELSE 'other' END;
--> statement-breakpoint
ALTER TABLE `assets` DROP COLUMN `type`;--> statement-breakpoint
CREATE INDEX `idx_assets_project_media_type` ON `assets` (`project_id`,`media_type`);--> statement-breakpoint
CREATE INDEX `idx_assets_project_category` ON `assets` (`project_id`,`category`);
