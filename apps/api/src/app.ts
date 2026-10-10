import Fastify from 'fastify';
import cors from '@fastify/cors';
import { normalizeGitHubRepository } from '@gitflow/core';
import { graphSchemaVersion } from '@gitflow/analyzer';
import { createGitHubClient, resolveRepository, type RepositoryMetadata } from '@gitflow/github';
import { z } from 'zod';
import { AnalysisStore } from './store.js';
import type { Persistence, QueuePublisher } from './persistence.js';
import { createMemoryPersistence } from './persistence.js';

const submitSchema = z.object({ url: z.string().min(1).max(2048) });
export interface AppOptions { store?: AnalysisStore; persistence?: Persistence; queue?: QueuePublisher; resolve?: (identity: ReturnType<typeof normalizeGitHubRepository>) => Promise<RepositoryMetadata>; analyzerVersion?: string; }

export function createApp(options: AppOptions = {}) {
  const persistence = options.persistence ?? (options.store ? createMemoryPersistence(options.store) : undefined);
  if (!persistence || !options.queue) throw new Error('API requires durable persistence and queue publisher.');
  const queue = options.queue;
  const analyzerVersion = options.analyzerVersion ?? process.env.ANALYZER_VERSION ?? 'manifest-v1';
  const resolver = options.resolve ?? ((identity) => resolveRepository(createGitHubClient(process.env.GITHUB_TOKEN), identity));
  const app = Fastify({ logger: true });
  void app.register(cors, { origin: true });
  app.get('/health', async () => ({ ok: true }));
  app.post('/repos', async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'A GitHub repository URL is required.' });
    let identity;
    try { identity = normalizeGitHubRepository(parsed.data.url); } catch (error) { return reply.code(400).send({ error: 'invalid_repository_url', message: (error as Error).message }); }
    try {
      const metadata = await resolver(identity);
      const result = await persistence.submit({ identity, defaultBranch: metadata.defaultBranch, description: metadata.description, sha: metadata.sha, visibility: metadata.visibility, analyzerVersion });
      if (!result.reused) {
        try { await queue.publish({ jobId: result.job.id, snapshotId: result.snapshot.id, owner: identity.owner, name: identity.name, sha: metadata.sha, analyzerVersion }); }
        catch (queueError) { await persistence.updateJob(result.job.id, { status: 'failed', errorMessage: 'The ingestion job could not be queued. Retry this repository.' }); return reply.code(503).send({ error: 'queue_unavailable', message: 'The repository was recorded, but processing could not be queued.' }); }
      }
      return reply.code(result.reused ? 200 : 202).send({ repository: result.repository, snapshot: result.snapshot, job: result.job, reused: result.reused });
    } catch (error) { const typed = error as { code?: string; message?: string }; const status = typed.code === 'rate_limited' ? 429 : typed.code === 'not_found_or_private' ? 404 : 502; return reply.code(status).send({ error: typed.code ?? 'github_error', message: typed.message ?? 'Unable to resolve repository.' }); }
  });
  app.get('/repos/:owner/:name', async (request, reply) => { const params = request.params as { owner: string; name: string }; const canonical = `${params.owner.toLowerCase()}/${params.name.toLowerCase()}`; const repo = await persistence.getRepository(canonical); if (!repo) return reply.code(404).send({ error: 'not_found', message: 'Repository has not been submitted.' }); const snapshot = await persistence.getLatestSnapshot(repo.id, analyzerVersion); const job = snapshot ? await persistence.getJobForSnapshot(snapshot.id) : undefined; const analysis = snapshot ? await persistence.getAnalysis(snapshot.id, analyzerVersion, graphSchemaVersion) : undefined; return { repository: { ...repo, sha: snapshot?.sha ?? repo.sha }, snapshot, job, analysis }; });
  app.get('/jobs/:id', async (request, reply) => { const job = await persistence.getJob((request.params as { id: string }).id); return job ? job : reply.code(404).send({ error: 'not_found', message: 'Job not found.' }); });
  app.get('/snapshots/:id/analysis', async (request, reply) => { const analysis = await persistence.getAnalysis((request.params as { id: string }).id, analyzerVersion, graphSchemaVersion); return analysis ? analysis : reply.code(404).send({ error: 'not_found', message: 'Analysis has not been requested.' }); });
  app.get('/snapshots/:id/graph', async (request, reply) => {
    const params = request.params as { id: string };
    const rawLimit = Number((request.query as { limit?: string }).limit ?? 500);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 5000) return reply.code(400).send({ error: 'invalid_limit', message: 'limit must be an integer between 1 and 5000.' });
    return persistence.getGraph(params.id, analyzerVersion, rawLimit);
  });
  return app;
}
