CREATE TABLE `cue_event_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`change_request_id` text NOT NULL,
	`event_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`updated_at` text NOT NULL,
	`delivered_at` text,
	`last_failure` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cue_event_delivery_request_subscription` ON `cue_event_delivery` (`change_request_id`,`subscription_id`);--> statement-breakpoint
CREATE INDEX `cue_event_delivery_event_updated` ON `cue_event_delivery` (`event_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `cue_event_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`event_id` text NOT NULL,
	`event_name` text NOT NULL,
	`callback_url` text NOT NULL,
	`secret` text NOT NULL,
	`previous_secret` text,
	`previous_secret_until` integer,
	`active` integer NOT NULL,
	`expires_at` text NOT NULL,
	`verified_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cue_event_subscription_event_active` ON `cue_event_subscription` (`event_id`,`active`,`expires_at`);