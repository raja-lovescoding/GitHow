import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const visibility = pgEnum('visibility', ['public', 'private']);
export const snapshotStatus = pgEnum('snapshot_status', ['requested', 'resolving', 'fetching', 'processing', 'ready', 'failed']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'completed', 'failed']);
export const jobStage = pgEnum('job_stage', ['resolving', 'fetching', 'manifest', 'storing', 'analysis', 'complete']);
export const analysisStatus = pgEnum('analysis_status', ['queued', 'running', 'completed', 'partial', 'failed']);

export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(), canonical: text('canonical').notNull(), visibility: visibility('visibility').notNull().default('public'), defaultBranch: text('default_branch'), description: text('description'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('repositories_canonical_idx').on(table.canonical)]);
export const snapshots = pgTable('snapshots', {
  id: uuid('id').defaultRandom().primaryKey(), repositoryId: uuid('repository_id').references(() => repositories.id).notNull(), commitSha: text('commit_sha').notNull(), analyzerVersion: text('analyzer_version').notNull(), status: snapshotStatus('status').notNull().default('requested'), manifest: jsonb('manifest'), archiveKey: text('archive_key'), manifestKey: text('manifest_key'), errorMessage: text('error_message'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('snapshots_identity_idx').on(table.repositoryId, table.commitSha, table.analyzerVersion), index('snapshots_status_idx').on(table.status)]);
export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(), snapshotId: uuid('snapshot_id').references(() => snapshots.id).notNull(), type: text('type').notNull(), status: jobStatus('status').notNull().default('queued'), stage: jobStage('stage').notNull().default('resolving'), progress: integer('progress').notNull().default(0), attempts: integer('attempts').notNull().default(0), errorMessage: text('error_message'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('jobs_snapshot_type_idx').on(table.snapshotId, table.type), index('jobs_snapshot_idx').on(table.snapshotId), index('jobs_status_idx').on(table.status)]);
export const analysisRuns = pgTable('analysis_runs', {
  id: uuid('id').defaultRandom().primaryKey(), snapshotId: uuid('snapshot_id').references(() => snapshots.id).notNull(), analyzerVersion: text('analyzer_version').notNull(), schemaVersion: text('schema_version').notNull(), status: analysisStatus('status').notNull().default('queued'), progress: integer('progress').notNull().default(0), diagnostics: jsonb('diagnostics'), errorMessage: text('error_message'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('analysis_runs_identity_idx').on(table.snapshotId, table.analyzerVersion, table.schemaVersion), index('analysis_runs_status_idx').on(table.status)]);
export const graphNodes = pgTable('graph_nodes', {
  id: text('id').primaryKey(), snapshotId: uuid('snapshot_id').references(() => snapshots.id).notNull(), analyzerVersion: text('analyzer_version').notNull(), nodeType: text('node_type').notNull(), nodeKey: text('node_key').notNull(), evidence: jsonb('evidence'),
}, (table) => [index('graph_nodes_snapshot_idx').on(table.snapshotId), uniqueIndex('graph_nodes_snapshot_key_idx').on(table.snapshotId, table.nodeKey)]);
export const graphEdges = pgTable('graph_edges', {
  id: text('id').primaryKey(), snapshotId: uuid('snapshot_id').references(() => snapshots.id).notNull(), analyzerVersion: text('analyzer_version').notNull(), edgeType: text('edge_type').notNull(), fromNodeId: text('from_node_id').notNull(), toNodeId: text('to_node_id').notNull(), resolution: text('resolution').notNull(), evidence: jsonb('evidence'),
}, (table) => [index('graph_edges_snapshot_idx').on(table.snapshotId), uniqueIndex('graph_edges_snapshot_key_idx').on(table.snapshotId, table.edgeType, table.fromNodeId, table.toNodeId, table.id)]);
