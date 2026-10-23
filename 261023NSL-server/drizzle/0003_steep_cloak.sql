CREATE TABLE `kiosk_translation_jobs` (
	`source_id` text PRIMARY KEY NOT NULL,
	`client_hash` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kiosk_translation_due_idx` ON `kiosk_translation_jobs` (`status`,`next_attempt_at`);