CREATE TABLE `kiosk_operation_states` (
	`source_id` text PRIMARY KEY NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`support_note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
