import Fastify from 'fastify';
import cors from '@fastify/cors';
import { normalizeGitHubRepository } from '@gitflow/core';
import { createGitHubClient, resolveRepository, type RepositoryMetadata } from '@gitflow/github';
import { z } from 'zod';
import { AnalysisStore } from './store.js';

const submitSchema = z.object({ url: z.string().min(1).max(2048) });
export interface AppOptions { store?: AnalysisStore; resolve?: (identity: ReturnType<typeof normalizeGitHubRepository>) => Promise<RepositoryMetadata>; }

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? new AnalysisStore();
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
      const result = store.create({ identity, defaultBranch: metadata.defaultBranch, description: metadata.description, sha: metadata.sha, visibility: metadata.visibility }, metadata.sha);
      const snapshot = result.snapshot; const job = result.job;
      if (result.reused) return reply.code(200).send({ repository: result.repo, snapshot, job, reused: true });
      return reply.code(202).send({ repository: result.repo, snapshot, job: result.job, reused: false });
    } catch (error) { const typed = error as { code?: string; message?: string }; const status = typed.code === 'rate_limited' ? 429 : typed.code === 'not_found_or_private' ? 404 : 502; return reply.code(status).send({ error: typed.code ?? 'github_error', message: typed.message ?? 'Unable to resolve repository.' }); }
  });
  app.get('/repos/:owner/:name', async (request, reply) => { const params = request.params as { owner: string; name: string }; const repo = store.repos.get(`${params.owner.toLowerCase()}/${params.name.toLowerCase()}`); if (!repo) return reply.code(404).send({ error: 'not_found', message: 'Repository has not been submitted.' }); const snapshot = store.findSnapshot(repo.identity.canonical, repo.sha); const job = snapshot && [...store.jobs.values()].find((item) => item.snapshotId === snapshot.id); return { repository: repo, snapshot, job }; });
  app.get('/jobs/:id', async (request, reply) => { const job = store.jobs.get((request.params as { id: string }).id); return job ? job : reply.code(404).send({ error: 'not_found', message: 'Job not found.' }); });
  return app;
}
