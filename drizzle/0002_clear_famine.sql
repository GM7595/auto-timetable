CREATE TABLE `cue_change_request` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`request_text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cue_change_request_event_created` ON `cue_change_request` (`event_id`,`created_at`);