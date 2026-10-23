import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const receivedEvents = sqliteTable("received_events", {
  eventId: text("event_id").primaryKey(),
  sourceId: text("source_id").notNull(),
  type: text("type", { enum: ["order.created", "service.requested"] }).notNull(),
  target: text("target", { enum: ["kitchen", "robot"] }).notNull(),
  payloadHash: text("payload_hash").notNull(),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull(),
}, (table) => [
  index("received_events_received_at_idx").on(table.receivedAt),
  index("received_events_source_id_idx").on(table.sourceId),
]);

// Independent kiosk tables are additive; receiver data and contract stay intact.
export const kioskMenu = sqliteTable('kiosk_menu', { id:text('id').primaryKey(), payload:text('payload').notNull(), sortOrder:integer('sort_order').notNull() });
export const kioskSessions = sqliteTable('kiosk_sessions', {
  id:text('id').primaryKey(), clientHash:text('client_hash').notNull(), payload:text('payload').notNull(), expiresAt:integer('expires_at').notNull(),
  lockOwner:text('lock_owner'), lockUntil:integer('lock_until').notNull().default(0),
}, t=>[index('kiosk_sessions_expiry_idx').on(t.expiresAt)]);
export const kioskConfirmations = sqliteTable('kiosk_confirmations', {
  token:text('token').primaryKey(), sessionId:text('session_id').notNull(), version:integer('version').notNull(), snapshot:text('snapshot').notNull(), expiresAt:integer('expires_at').notNull(),
},t=>[index('kiosk_confirmations_session_idx').on(t.sessionId)]);
export const kioskTurns = sqliteTable('kiosk_turns', {
  key:text('key').primaryKey(), sessionId:text('session_id').notNull(), inputHash:text('input_hash').notNull(), response:text('response').notNull(), createdAt:integer('created_at').notNull(),
}, t=>[index('kiosk_turns_session_idx').on(t.sessionId)]);
export const kioskOrders = sqliteTable('kiosk_orders', {
  id:text('id').primaryKey(), sessionId:text('session_id').notNull(), confirmationToken:text('confirmation_token').notNull(), payload:text('payload').notNull(), createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('kiosk_orders_confirmation_idx').on(t.confirmationToken),index('kiosk_orders_session_idx').on(t.sessionId)]);
export const kioskServices = sqliteTable('kiosk_services', {
  id:text('id').primaryKey(), sessionId:text('session_id').notNull(), payload:text('payload').notNull(), createdAt:text('created_at').notNull(),
},t=>[index('kiosk_services_session_idx').on(t.sessionId)]);
export const kioskOutbox = sqliteTable('kiosk_outbox', {
  id:text('id').primaryKey(), eventId:text('event_id').notNull(), sourceId:text('source_id').notNull(), target:text('target').notNull(), url:text('url').notNull(), payload:text('payload').notNull(),
  status:text('status').notNull(), attempts:integer('attempts').notNull().default(0), nextAttemptAt:integer('next_attempt_at').notNull(), lastError:text('last_error'), deliveredAt:text('delivered_at'), createdAt:text('created_at').notNull(), leaseOwner:text('lease_owner'), leaseUntil:integer('lease_until').notNull().default(0),
},t=>[index('kiosk_outbox_due_idx').on(t.status,t.nextAttemptAt),index('kiosk_outbox_source_idx').on(t.sourceId),uniqueIndex('kiosk_outbox_event_idx').on(t.eventId)]);
export const kioskQuotas = sqliteTable('kiosk_quotas', { key:text('key').primaryKey(), used:integer('used').notNull(), expiresAt:integer('expires_at').notNull() },t=>[index('kiosk_quotas_expiry_idx').on(t.expiresAt)]);
export const kioskOperationStates = sqliteTable('kiosk_operation_states', {
  sourceId:text('source_id').primaryKey(), stage:text('stage').notNull().default('new'), supportNote:text('support_note').notNull().default(''),
  version:integer('version').notNull().default(0), updatedAt:text('updated_at').notNull(),
});
export const kioskTranslationJobs = sqliteTable('kiosk_translation_jobs', {
  sourceId:text('source_id').primaryKey(), clientHash:text('client_hash').notNull(), attempts:integer('attempts').notNull().default(1),
  nextAttemptAt:integer('next_attempt_at').notNull(), status:text('status').notNull().default('pending'),
  leaseOwner:text('lease_owner'), leaseUntil:integer('lease_until').notNull().default(0),
}, t=>[index('kiosk_translation_due_idx').on(t.status,t.nextAttemptAt)]);
