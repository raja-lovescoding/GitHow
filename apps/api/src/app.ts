import Fastify from 'fastify';
import cors from '@fastify/cors';
import { normalizeGitHubRepository, type ManifestEntry } from '@gitflow/core';
import { isBinaryExtension } from '@gitflow/ingest';
import { assembleFlow, findFlowCandidates, graphSchemaVersion, type AnalysisResult } from '@gitflow/analyzer';
import { createGitHubClient, resolveRepository, type RepositoryMetadata } from '@gitflow/github';
import { z } from 'zod';
import { AnalysisStore } from './store.js';
import type { Persistence, QueuePublisher } from './persistence.js';
import { createMemoryPersistence } from './persistence.js';

const submitSchema = z.object({ url: z.string().min(1).max(2048) });
export interface SnapshotSourceReader { getManifest(snapshotId: string): Promise<ManifestEntry[]>; getSource(snapshotId: string, relativePath: string): Promise<{ path: string; content: string; language: string | null; bytes: number; lineCount: number }>; }
export interface AppOptions { store?: AnalysisStore; persistence?: Persistence; queue?: QueuePublisher; resolve?: (identity: ReturnType<typeof normalizeGitHubRepository>) => Promise<RepositoryMetadata>; analyzerVersion?: string; sourceReader?: SnapshotSourceReader; }

function normalizeSnapshotPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\')) throw new Error('Source paths must be relative to the repository root.');
  const normalized = trimmed.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '.' || !part)) throw new Error('Source paths must not contain traversal segments.');
  return normalized;
}

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
  app.get('/snapshots/:id/manifest', async (request, reply) => {
    const snapshotId = (request.params as { id: string }).id;
    const snapshot = await persistence.getSnapshot(snapshotId);
    if (!snapshot) return reply.code(404).send({ error: 'not_found', message: 'Snapshot not found.' });
    if (!snapshot.manifest) return reply.code(200).send([]);
    const manifest = Array.isArray(snapshot.manifest) ? snapshot.manifest as ManifestEntry[] : [];
    return manifest;
  });
  app.get('/snapshots/:id/source', async (request, reply) => {
    const snapshotId = (request.params as { id: string }).id;
    if (!z.string().uuid().safeParse(snapshotId).success) return reply.code(404).send({ error: 'not_found', message: 'Snapshot not found.' });
    const snapshot = await persistence.getSnapshot(snapshotId);
    if (!snapshot) return reply.code(404).send({ error: 'not_found', message: 'Snapshot not found.' });
    const rawPath = (request.query as { path?: string }).path;
    if (!rawPath) return reply.code(400).send({ error: 'missing_path', message: 'path is required.' });
    let relativePath: string;
    try { relativePath = normalizeSnapshotPath(rawPath); } catch (error) { return reply.code(400).send({ error: 'invalid_path', message: (error as Error).message }); }
    const supported = Array.isArray(snapshot.manifest) ? snapshot.manifest as ManifestEntry[] : [];
    const manifestEntry = supported.find((entry) => entry.path === relativePath);
    if (!manifestEntry) return reply.code(404).send({ error: 'not_found', message: `File not found in repository manifest: ${relativePath}` });
    if (manifestEntry.classification === 'binary' || isBinaryExtension(manifestEntry.extension)) {
      return reply.code(400).send({ error: 'binary_file', message: 'Binary files cannot be viewed as text.' });
    }
    if (manifestEntry.size > 5 * 1024 * 1024) {
      return reply.code(400).send({ error: 'file_too_large', message: 'File exceeds maximum viewable size of 5MB.' });
    }
    if (!options.sourceReader) return reply.code(501).send({ error: 'source_unavailable', message: 'Source content retrieval is not configured for this API deployment.' });
    try {
      const source = await options.sourceReader.getSource(snapshotId, relativePath);
      return source;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load source content.';
      return reply.code(404).send({ error: 'source_missing', message });
    }
  });
  app.get('/snapshots/:id/graph', async (request, reply) => {
    const params = request.params as { id: string };
    const rawLimit = Number((request.query as { limit?: string }).limit ?? 500);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 5000) return reply.code(400).send({ error: 'invalid_limit', message: 'limit must be an integer between 1 and 5000.' });
    return persistence.getGraph(params.id, analyzerVersion, graphSchemaVersion, rawLimit);
  });
  app.get('/snapshots/:id/nodes/:nodeId/neighborhood', async (request, reply) => {
    const params = request.params as { id: string; nodeId: string };
    const rawLimit = Number((request.query as { limit?: string }).limit ?? 50);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) return reply.code(400).send({ error: 'invalid_limit', message: 'limit must be an integer between 1 and 200.' });
    return persistence.getNodeNeighborhood(params.id, analyzerVersion, graphSchemaVersion, params.nodeId, rawLimit);
  });
  app.get('/snapshots/:id/flows', async (request, reply) => {
    const snapshotId = (request.params as { id: string }).id;
    const rawLimit = Number((request.query as { limit?: string }).limit ?? 100);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) return reply.code(400).send({ error: 'invalid_limit', message: 'limit must be an integer between 1 and 100.' });
    const graphData = await persistence.getGraph(snapshotId, analyzerVersion, graphSchemaVersion, 5000) as { nodes?: AnalysisResult['nodes']; edges?: AnalysisResult['edges'] };
    const graph: Pick<AnalysisResult, 'snapshotId' | 'nodes'> = { snapshotId, nodes: graphData?.nodes ?? [] };
    return { snapshotId, candidates: findFlowCandidates(graph, rawLimit) };
  });
  app.get('/snapshots/:id/flows/:flowId', async (request, reply) => {
    const params = request.params as { id: string; flowId: string };
    const graphData = await persistence.getGraph(params.id, analyzerVersion, graphSchemaVersion, 5000) as { nodes?: AnalysisResult['nodes']; edges?: AnalysisResult['edges'] };
    const graph: Pick<AnalysisResult, 'snapshotId' | 'analyzerVersion' | 'nodes' | 'edges'> = { snapshotId: params.id, analyzerVersion, nodes: graphData?.nodes ?? [], edges: graphData?.edges ?? [] };
    const flow = assembleFlow(graph, params.flowId);
    return flow ? flow : reply.code(404).send({ error: 'not_found', message: 'Flow candidate not found for this snapshot.' });
  });
  return app;
}
