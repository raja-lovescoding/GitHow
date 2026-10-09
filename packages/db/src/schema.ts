import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const visibility = pgEnum('visibility', ['public', 'private']);
export const snapshotStatus = pgEnum('snapshot_status', ['requested', 'resolving', 'fetching', 'processing', 'ready', 'failed']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'completed', 'failed']);
export const jobStage = pgEnum('job_stage', ['resolving', 'fetching', 'manifest', 'storing', 'complete']);

export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(), canonical: text('canonical').notNull(), visibility: visibility('visibility').notNull().default('public'), defaultBranch: text('default_branch'), description: text('description'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('repositories_canonical_idx').on(table.canonical)]);
export const snapshots = pgTable('snapshots', {
  id: uuid('id').defaultRandom().primaryKey(), repositoryId: uuid('repository_id').references(() => repositories.id).notNull(), commitSha: text('commit_sha').notNull(), analyzerVersion: text('analyzer_version').notNull(), status: snapshotStatus('status').notNull().default('requested'), manifest: jsonb('manifest'), archiveKey: text('archive_key'), errorMessage: text('error_message'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('snapshots_identity_idx').on(table.repositoryId, table.commitSha, table.analyzerVersion), index('snapshots_status_idx').on(table.status)]);
export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(), snapshotId: uuid('snapshot_id').references(() => snapshots.id).notNull(), type: text('type').notNull(), status: jobStatus('status').notNull().default('queued'), stage: jobStage('stage').notNull().default('resolving'), progress: integer('progress').notNull().default(0), attempts: integer('attempts').notNull().default(0), errorMessage: text('error_message'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('jobs_snapshot_idx').on(table.snapshotId), index('jobs_status_idx').on(table.status)]);
