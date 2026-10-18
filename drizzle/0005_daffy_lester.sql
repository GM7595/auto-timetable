CREATE TABLE `cue_saved_event` (
	`event_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cue_saved_event_updated` ON `cue_saved_event` (`updated_at`);