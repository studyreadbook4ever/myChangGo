CREATE TABLE `kiosk_confirmations` (
	`token` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kiosk_confirmations_session_idx` ON `kiosk_confirmations` (`session_id`);--> statement-breakpoint
CREATE TABLE `kiosk_menu` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`sort_order` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kiosk_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`confirmation_token` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kiosk_orders_confirmation_idx` ON `kiosk_orders` (`confirmation_token`);--> statement-breakpoint
CREATE INDEX `kiosk_orders_session_idx` ON `kiosk_orders` (`session_id`);--> statement-breakpoint
CREATE TABLE `kiosk_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target` text NOT NULL,
	`url` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`delivered_at` text,
	`created_at` text NOT NULL,
	`lease_owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kiosk_outbox_due_idx` ON `kiosk_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `kiosk_outbox_source_idx` ON `kiosk_outbox` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kiosk_outbox_event_idx` ON `kiosk_outbox` (`event_id`);--> statement-breakpoint
CREATE TABLE `kiosk_quotas` (
	`key` text PRIMARY KEY NOT NULL,
	`used` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kiosk_quotas_expiry_idx` ON `kiosk_quotas` (`expires_at`);--> statement-breakpoint
CREATE TABLE `kiosk_services` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kiosk_services_session_idx` ON `kiosk_services` (`session_id`);--> statement-breakpoint
CREATE TABLE `kiosk_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`client_hash` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`lock_owner` text,
	`lock_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kiosk_sessions_expiry_idx` ON `kiosk_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `kiosk_turns` (
	`key` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`response` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kiosk_turns_session_idx` ON `kiosk_turns` (`session_id`);