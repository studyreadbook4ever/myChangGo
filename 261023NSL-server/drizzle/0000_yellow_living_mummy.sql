CREATE TABLE `received_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`type` text NOT NULL,
	`target` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `received_events_received_at_idx` ON `received_events` (`received_at`);--> statement-breakpoint
CREATE INDEX `received_events_source_id_idx` ON `received_events` (`source_id`);