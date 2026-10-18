CREATE TABLE `cue_agent_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`request_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`request_text` text NOT NULL,
	`created_at` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cue_agent_proposal_event_request` ON `cue_agent_proposal` (`event_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `cue_agent_proposal_event_created` ON `cue_agent_proposal` (`event_id`,`created_at`);