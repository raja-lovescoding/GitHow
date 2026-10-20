import { analysisJobPayloadSchema, manifestEntrySchema, type AnalysisJobPayload } from '@gitflow/core';
import { analyzeRepository, type AnalysisResult } from '@gitflow/analyzer';
import { extractSourceFiles } from '@gitflow/ingest';

export interface AnalysisRunnerDependencies {
  getObject(key: string): Promise<Buffer>;
  getExisting(snapshotId: string, analyzerVersion: string, schemaVersion: string): Promise<{ status: string } | undefined>;
  updateStatus(snapshotId: string, analyzerVersion: string, schemaVersion: string, values: { status?: 'queued' | 'running' | 'completed' | 'partial' | 'failed'; progress?: number; diagnostics?: unknown; errorMessage?: string | null }): Promise<void>;
  persist(result: AnalysisResult): Promise<void>;
}

export async function runAnalysisJob(raw: unknown, dependencies: AnalysisRunnerDependencies): Promise<'skipped' | 'completed'> {
  const payload: AnalysisJobPayload = analysisJobPayloadSchema.parse(raw);
  const existing = await dependencies.getExisting(payload.snapshotId, payload.analyzerVersion, payload.schemaVersion);
  if (existing?.status === 'completed' || existing?.status === 'partial') return 'skipped';
  await dependencies.updateStatus(payload.snapshotId, payload.analyzerVersion, payload.schemaVersion, { status: 'running', progress: 10, errorMessage: null });
  const manifest = manifestEntrySchema.array().parse(JSON.parse((await dependencies.getObject(payload.manifestKey)).toString('utf8')));
  const files = await extractSourceFiles(await dependencies.getObject(payload.archiveKey), manifest);
  await dependencies.updateStatus(payload.snapshotId, payload.analyzerVersion, payload.schemaVersion, { progress: 65 });
  const result = await analyzeRepository({ snapshotId: payload.snapshotId, files, manifest, analyzerVersion: payload.analyzerVersion });
  await dependencies.persist(result);
  return 'completed';
}
