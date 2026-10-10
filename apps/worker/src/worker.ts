import 'dotenv/config';
import { loadConfig } from '@gitflow/config';
import { analysisJobPayloadSchema, ingestionJobPayloadSchema } from '@gitflow/core';
import { graphSchemaVersion } from '@gitflow/analyzer';
import { createDatabase, ensureAnalysisJob, getAnalysis, getQueuedAnalysisJobs, persistAnalysis, updateAnalysis, updateJob, updateSnapshot } from '@gitflow/db';
import { createGitHubClient, downloadArchive } from '@gitflow/github';
import { buildManifest } from '@gitflow/ingest';
import { createObjectStorage } from '@gitflow/storage';
import { PgBoss } from 'pg-boss';
import { runAnalysisJob } from './analysis.js';

const queueName = 'repository-ingestion';
const analysisQueueName = 'repository-analysis';
const config = loadConfig();
const { db, sql } = createDatabase(config.DATABASE_URL);
const storage = createObjectStorage({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY, bucket: config.S3_BUCKET });
const github = createGitHubClient(config.GITHUB_TOKEN);
const boss = new PgBoss(config.DATABASE_URL);
const publishQueuedAnalysis = async () => {
  const queued = await getQueuedAnalysisJobs(db);
  await Promise.all(queued.map(async ({ job, snapshot }) => {
    if (!snapshot.archiveKey || !snapshot.manifestKey) return;
    await boss.send(analysisQueueName, { jobId: job.id, snapshotId: snapshot.id, archiveKey: snapshot.archiveKey, manifestKey: snapshot.manifestKey, sha: snapshot.sha, analyzerVersion: snapshot.analyzerVersion, schemaVersion: graphSchemaVersion }, { singletonKey: `analysis:${snapshot.id}:${snapshot.analyzerVersion}:${graphSchemaVersion}` });
  }));
};

await storage.ensureBucket();
await boss.start();
await boss.createQueue(queueName, { retryLimit: 3, retryDelay: 30 });
await boss.work(queueName, async (jobs) => {
  const raw = jobs[0]?.data;
  const payload = ingestionJobPayloadSchema.parse(raw);
  const uploadedKeys: string[] = [];
  try {
    await updateJob(db, payload.jobId, { status: 'running', stage: 'fetching', progress: 15, attempts: (jobs[0]?.retryCount ?? 0) + 1 });
    const archive = await downloadArchive(github, { owner: payload.owner, name: payload.name, canonical: `${payload.owner}/${payload.name}` }, payload.sha);
    await updateJob(db, payload.jobId, { stage: 'manifest', progress: 45 });
    const manifest = await buildManifest(archive);
    const baseKey = `public/${payload.owner}/${payload.name}/${payload.sha}/${payload.analyzerVersion}`;
    await storage.put(`${baseKey}/archive.tar.gz`, archive, 'application/gzip');
    uploadedKeys.push(`${baseKey}/archive.tar.gz`);
    await storage.put(`${baseKey}/manifest.json`, Buffer.from(JSON.stringify(manifest), 'utf8'), 'application/json');
    uploadedKeys.push(`${baseKey}/manifest.json`);
    await updateJob(db, payload.jobId, { stage: 'storing', progress: 90 });
    await updateSnapshot(db, payload.snapshotId, { status: 'ready', manifest, archiveKey: `${baseKey}/archive.tar.gz`, manifestKey: `${baseKey}/manifest.json`, errorMessage: null });
    await updateJob(db, payload.jobId, { status: 'completed', stage: 'complete', progress: 100, errorMessage: null });
    try {
      const analysisJob = await ensureAnalysisJob(db, payload.snapshotId, payload.analyzerVersion, graphSchemaVersion);
      await boss.send(analysisQueueName, { jobId: analysisJob.id, snapshotId: payload.snapshotId, archiveKey: `${baseKey}/archive.tar.gz`, manifestKey: `${baseKey}/manifest.json`, sha: payload.sha, analyzerVersion: payload.analyzerVersion, schemaVersion: graphSchemaVersion }, { singletonKey: `analysis:${payload.snapshotId}:${payload.analyzerVersion}:${graphSchemaVersion}` });
    } catch (analysisQueueError) {
      const message = analysisQueueError instanceof Error ? analysisQueueError.message : 'Analysis could not be queued.';
      await updateAnalysis(db, payload.snapshotId, payload.analyzerVersion, graphSchemaVersion, { status: 'queued', progress: 0, errorMessage: message });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Repository ingestion failed.';
    await Promise.allSettled(uploadedKeys.map((key) => storage.delete(key)));
    const retryCount = jobs[0]?.retryCount ?? 0;
    const permanentFailure = /unsafe path|exceeds the configured|larger than the configured|more files than the configured|unsupported archive response/i.test(message);
    if (!permanentFailure && retryCount < 2) { await updateJob(db, payload.jobId, { status: 'queued', errorMessage: message }); throw error; }
    await updateSnapshot(db, payload.snapshotId, { status: 'failed', errorMessage: message });
    await updateJob(db, payload.jobId, { status: 'failed', progress: 100, errorMessage: message });
  }
});

await publishQueuedAnalysis().catch((error) => console.error(JSON.stringify({ event: 'analysis_queue_recovery_failed', message: error instanceof Error ? error.message : 'Unknown error' })));
const analysisRecoveryTimer = setInterval(() => { void publishQueuedAnalysis().catch((error) => console.error(JSON.stringify({ event: 'analysis_queue_recovery_failed', message: error instanceof Error ? error.message : 'Unknown error' }))); }, 30_000);

await boss.work(analysisQueueName, async (jobs) => {
  const raw = jobs[0]?.data;
  const payload = analysisJobPayloadSchema.parse(raw);
  const retryCount = jobs[0]?.retryCount ?? 0;
  try {
    await updateJob(db, payload.jobId, { status: 'running', stage: 'analysis', progress: 10, attempts: retryCount + 1, errorMessage: null });
    const result = await runAnalysisJob(raw, {
      getObject: (key) => storage.get(key),
      getExisting: async (snapshotId, analyzerVersion, schemaVersion) => getAnalysis(db, snapshotId, analyzerVersion, schemaVersion),
      updateStatus: (snapshotId, analyzerVersion, schemaVersion, values) => updateAnalysis(db, snapshotId, analyzerVersion, schemaVersion, values),
      persist: (analysis) => persistAnalysis(db, analysis),
    });
    if (result === 'skipped') {
      await updateJob(db, payload.jobId, { status: 'completed', stage: 'complete', progress: 100, errorMessage: null });
      return;
    }
    await updateJob(db, payload.jobId, { status: 'completed', stage: 'complete', progress: 100, errorMessage: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Repository analysis failed.';
    await updateAnalysis(db, payload.snapshotId, payload.analyzerVersion, payload.schemaVersion, { status: retryCount < 2 ? 'queued' : 'failed', progress: retryCount < 2 ? 0 : 100, errorMessage: message });
    await updateJob(db, payload.jobId, { status: retryCount < 2 ? 'queued' : 'failed', progress: retryCount < 2 ? 0 : 100, errorMessage: message });
    if (retryCount < 2) throw error;
  }
});

const shutdown = async () => { clearInterval(analysisRecoveryTimer); await boss.stop(); await sql.end(); process.exit(0); };
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
console.log(JSON.stringify({ event: 'worker_started', queue: queueName }));
