import {index,integer,sqliteTable,text} from 'drizzle-orm/sqlite-core';
export const robotJobs=sqliteTable('robot_jobs',{
  id:text('id').primaryKey(),sourceId:text('source_id').notNull(),eventType:text('event_type').notNull(),payloadHash:text('payload_hash').notNull(),
  eventPayload:text('event_payload').notNull(),jobPayload:text('job_payload').notNull(),version:integer('version').notNull().default(0),
  lockOwner:text('lock_owner'),lockUntil:integer('lock_until').notNull().default(0),receivedAt:text('received_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('robot_jobs_received_idx').on(t.receivedAt),index('robot_jobs_source_idx').on(t.sourceId)]);
export const robotTurns=sqliteTable('robot_turns',{
  key:text('key').primaryKey(),jobId:text('job_id').notNull(),inputHash:text('input_hash').notNull(),response:text('response').notNull(),createdAt:text('created_at').notNull(),
},t=>[index('robot_turns_job_idx').on(t.jobId)]);
export const robotQuotas=sqliteTable('robot_quotas',{key:text('key').primaryKey(),used:integer('used').notNull(),expiresAt:integer('expires_at').notNull()});
