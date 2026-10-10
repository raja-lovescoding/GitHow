import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';
import { buildManifest } from '@gitflow/ingest';
import { graphSchemaVersion } from '@gitflow/analyzer';
import { runAnalysisJob } from './analysis.js';

async function archive(path: string, content: string): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name: `root/${path}`, type: 'file' }, content);
  pack.finalize();
  return new Promise((resolve, reject) => { const chunks: Buffer[] = []; pack.on('data', (chunk) => chunks.push(chunk as Buffer)); pack.on('end', () => resolve(gzipSync(Buffer.concat(chunks)))); pack.on('error', reject); });
}

describe('analysis worker runner', () => {
  it('is idempotent for duplicate delivery and keeps snapshot payload identity', async () => {
    const archiveBuffer = await archive('src/index.ts', 'export function answer() { return 42; }');
    const manifest = await buildManifest(archiveBuffer);
    const statuses: string[] = [];
    const persist = vi.fn();
    const dependencies = { getObject: async (key: string) => key.endsWith('manifest') ? Buffer.from(JSON.stringify(manifest)) : archiveBuffer, getExisting: async () => undefined, updateStatus: async (_snapshot: string, _version: string, _schema: string, values: { status?: string }) => { if (values.status) statuses.push(values.status); }, persist };
    const payload = { jobId: '00000000-0000-0000-0000-000000000001', snapshotId: '00000000-0000-0000-0000-000000000002', archiveKey: 'snapshot-a/archive', manifestKey: 'snapshot-a/manifest', sha: 'a'.repeat(40), analyzerVersion: 'manifest-v1', schemaVersion: graphSchemaVersion };
    await expect(runAnalysisJob(payload, dependencies)).resolves.toBe('completed');
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: payload.snapshotId, analyzerVersion: payload.analyzerVersion }));
    expect(statuses).toEqual(['running']);
  });

  it('does not execute or analyze a different snapshot payload', async () => {
    const getExisting = vi.fn(async () => ({ status: 'completed' }));
    const dependencies = { getObject: vi.fn(), getExisting, updateStatus: vi.fn(), persist: vi.fn() };
    const payload = { jobId: '00000000-0000-0000-0000-000000000003', snapshotId: '00000000-0000-0000-0000-000000000004', archiveKey: 'archive', manifestKey: 'manifest', sha: 'b'.repeat(40), analyzerVersion: 'manifest-v1', schemaVersion: graphSchemaVersion };
    await expect(runAnalysisJob(payload, dependencies)).resolves.toBe('skipped');
    expect(dependencies.getObject).not.toHaveBeenCalled();
  });

  it('surfaces extraction failures for durable retry handling', async () => {
    const updateStatus = vi.fn();
    const dependencies = { getObject: async () => Buffer.from('not-a-gzip-archive'), getExisting: async () => undefined, updateStatus, persist: vi.fn() };
    const payload = { jobId: '00000000-0000-0000-0000-000000000005', snapshotId: '00000000-0000-0000-0000-000000000006', archiveKey: 'archive', manifestKey: 'manifest', sha: 'c'.repeat(40), analyzerVersion: 'manifest-v1', schemaVersion: graphSchemaVersion };
    await expect(runAnalysisJob(payload, dependencies)).rejects.toThrow();
    expect(updateStatus).toHaveBeenCalledWith(payload.snapshotId, payload.analyzerVersion, payload.schemaVersion, expect.objectContaining({ status: 'running' }));
  });
});
