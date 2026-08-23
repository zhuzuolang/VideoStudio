CREATE TABLE `workspace_initializations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`initialized_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `workspaces`(`user_id`) ON UPDATE no action ON DELETE cascade
);
