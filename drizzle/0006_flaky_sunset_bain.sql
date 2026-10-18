CREATE TABLE `cue_proposal_view` (
	`proposal_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`base_revision` integer,
	`result` text,
	`updated_at` text NOT NULL,
	`dismissed_at` text,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cue_proposal_view_event_dismissed` ON `cue_proposal_view` (`event_id`,`dismissed_at`);