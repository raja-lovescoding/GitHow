import { describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { ensureAnalysisJob, getAnalysis, getGraph, getNodeNeighborhood, persistAnalysis, submitSnapshot } from './repository.js';
import { graphSchemaVersion, analyzerVersion } from '@gitflow/analyzer';

describe('PostgreSQL persistence integration', () => {
  it.skipIf(process.env.INTEGRATION !== '1')('deduplicates the same repository/SHA/analyzer tuple', async () => {
    const { db, sql } = createDatabase(process.env.DATABASE_URL ?? 'postgres://gitflow:gitflow@localhost:5433/gitflow');
    const metadata = { identity: { owner: 'fixture', name: `repo-${process.pid}`, canonical: `fixture/repo-${process.pid}` }, defaultBranch: 'main', description: null, sha: 'a'.repeat(40), visibility: 'public' as const, analyzerVersion: 'test-v1' };
    const first = await submitSnapshot(db, metadata); const second = await submitSnapshot(db, metadata);
    expect(first.reused).toBe(false); expect(second.reused).toBe(true); await sql`delete from jobs where snapshot_id in (select id from snapshots where repository_id in (select id from repositories where canonical = ${metadata.identity.canonical}))`; await sql`delete from snapshots where repository_id in (select id from repositories where canonical = ${metadata.identity.canonical})`; await sql`delete from repositories where canonical = ${metadata.identity.canonical}`; await sql.end();
  });
  it.skipIf(process.env.INTEGRATION !== '1')('isolates and replaces one immutable analysis run idempotently', async () => {
    const { db, sql } = createDatabase(process.env.DATABASE_URL ?? 'postgres://gitflow:gitflow@localhost:5433/gitflow');
    const metadata = { identity: { owner: 'fixture', name: `graph-${process.pid}`, canonical: `fixture/graph-${process.pid}` }, defaultBranch: 'main', description: null, sha: 'b'.repeat(40), visibility: 'public' as const, analyzerVersion };
    const submission = await submitSnapshot(db, metadata);
    const job = await ensureAnalysisJob(db, submission.snapshot.id, analyzerVersion, graphSchemaVersion);
    const duplicate = await ensureAnalysisJob(db, submission.snapshot.id, analyzerVersion, graphSchemaVersion);
    expect(duplicate.id).toBe(job.id);
    const result = {
      schemaVersion: graphSchemaVersion,
      analyzerVersion,
      snapshotId: submission.snapshot.id,
      nodes: [
        { id: `node-${process.pid}`, type: 'snapshot' as const, snapshotId: submission.snapshot.id, analyzerVersion, key: submission.snapshot.id },
        { id: `node2-${process.pid}`, type: 'file' as const, snapshotId: submission.snapshot.id, analyzerVersion, key: 'file.ts' },
      ],
      edges: [
        { id: `edge-contains-${process.pid}`, type: 'CONTAINS' as const, snapshotId: submission.snapshot.id, analyzerVersion, from: `node-${process.pid}`, to: `node2-${process.pid}`, resolution: 'observed' as const, evidence: { path: 'file.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } },
        { id: `edge-depends-${process.pid}`, type: 'DEPENDS_ON' as const, snapshotId: submission.snapshot.id, analyzerVersion, from: `node2-${process.pid}`, to: `node2-${process.pid}`, resolution: 'resolved' as const, evidence: { path: 'file.ts', startLine: 5, startColumn: 1, endLine: 5, endColumn: 10, name: 'dep' } },
        { id: `edge-hook-${process.pid}`, type: 'HOOK' as const, snapshotId: submission.snapshot.id, analyzerVersion, from: `node2-${process.pid}`, to: `node2-${process.pid}`, resolution: 'resolved' as const, evidence: { path: 'file.ts', startLine: 10, startColumn: 1, endLine: 10, endColumn: 15, name: 'hook' } },
        { id: `edge-plugin-${process.pid}`, type: 'PLUGIN' as const, snapshotId: submission.snapshot.id, analyzerVersion, from: `node2-${process.pid}`, to: `node2-${process.pid}`, resolution: 'resolved' as const, evidence: { path: 'file.ts', startLine: 15, startColumn: 1, endLine: 15, endColumn: 20, name: 'plugin' } },
        { id: `edge-flows-${process.pid}`, type: 'FLOWS_TO' as const, snapshotId: submission.snapshot.id, analyzerVersion, from: `node2-${process.pid}`, to: `node2-${process.pid}`, resolution: 'resolved' as const, evidence: { path: 'file.ts', startLine: 20, startColumn: 1, endLine: 20, endColumn: 25, attributes: { channel: 'argument_pass', parameterIndex: 0 } as Record<string, string | number | boolean> } },
        { id: `edge-returns-${process.pid}`, type: 'RETURNS_TO' as const, snapshotId: submission.snapshot.id, analyzerVersion, from: `node2-${process.pid}`, to: `node2-${process.pid}`, resolution: 'resolved' as const, evidence: { path: 'file.ts', startLine: 25, startColumn: 1, endLine: 25, endColumn: 30, attributes: { channel: 'return_value' } as Record<string, string | number | boolean> } },
      ],
      diagnostics: [],
    };
    await persistAnalysis(db, result);
    await persistAnalysis(db, result);
    await expect(getAnalysis(db, submission.snapshot.id, analyzerVersion, graphSchemaVersion)).resolves.toMatchObject({ status: 'completed', progress: 100 });
    const graph = await getGraph(db, submission.snapshot.id, analyzerVersion, graphSchemaVersion);
    expect(graph.nodes.some((n) => n.id === `node-${process.pid}`)).toBe(true);
    expect(graph.edges.some((e) => e.id === `edge-contains-${process.pid}`)).toBe(true);
    expect(graph.edges.some((e) => e.id === `edge-depends-${process.pid}` && e.type === 'DEPENDS_ON')).toBe(true);
    expect(graph.edges.some((e) => e.id === `edge-hook-${process.pid}` && e.type === 'HOOK')).toBe(true);
    expect(graph.edges.some((e) => e.id === `edge-plugin-${process.pid}` && e.type === 'PLUGIN')).toBe(true);
    expect(graph.edges.some((e) => e.id === `edge-flows-${process.pid}` && e.type === 'FLOWS_TO')).toBe(true);
    expect(graph.edges.some((e) => e.id === `edge-returns-${process.pid}` && e.type === 'RETURNS_TO')).toBe(true);
    const neighborhood = await getNodeNeighborhood(db, submission.snapshot.id, analyzerVersion, graphSchemaVersion, `node-${process.pid}`);
    expect(neighborhood.nodes).toHaveLength(2);
    expect(neighborhood.edges).toHaveLength(1);
    await sql`delete from graph_edges where snapshot_id = ${submission.snapshot.id}`; await sql`delete from graph_nodes where snapshot_id = ${submission.snapshot.id}`; await sql`delete from analysis_runs where snapshot_id = ${submission.snapshot.id}`; await sql`delete from jobs where snapshot_id = ${submission.snapshot.id}`; await sql`delete from snapshots where id = ${submission.snapshot.id}`; await sql`delete from repositories where canonical = ${metadata.identity.canonical}`; await sql.end();
  });
});
