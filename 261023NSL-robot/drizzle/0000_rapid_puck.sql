CREATE TABLE `robot_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_hash` text NOT NULL,
	`event_payload` text NOT NULL,
	`job_payload` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lock_owner` text,
	`lock_until` integer DEFAULT 0 NOT NULL,
	`received_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `robot_jobs_received_idx` ON `robot_jobs` (`received_at`);--> statement-breakpoint
CREATE INDEX `robot_jobs_source_idx` ON `robot_jobs` (`source_id`);--> statement-breakpoint
CREATE TABLE `robot_quotas` (
	`key` text PRIMARY KEY NOT NULL,
	`used` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `robot_turns` (
	`key` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`response` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `robot_turns_job_idx` ON `robot_turns` (`job_id`);