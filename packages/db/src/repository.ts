import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { RepoIdentity, SnapshotStatus, JobStage } from '@gitflow/core';
import { analysisRuns, graphEdges, graphNodes, jobs, repositories, snapshots } from './schema.js';
import type { AnalysisResult, GraphEdge, GraphNode } from '@gitflow/analyzer';
import type { Database } from './client.js';

export interface DurableRepository { id: string; identity: RepoIdentity; defaultBranch: string; description: string | null; sha: string; visibility: 'public' | 'private'; }
export interface DurableSnapshot { id: string; repoId: string; sha: string; analyzerVersion: string; status: SnapshotStatus; manifest: unknown; archiveKey: string | null; manifestKey: string | null; errorMessage: string | null; }
export interface DurableJob { id: string; snapshotId: string; type: string; status: 'queued' | 'running' | 'completed' | 'failed'; stage: JobStage; progress: number; attempts: number; errorMessage: string | null; }
export interface Submission { repository: DurableRepository; snapshot: DurableSnapshot; job: DurableJob; reused: boolean; }
export interface DurableAnalysis { id: string; snapshotId: string; analyzerVersion: string; schemaVersion: string; status: 'queued' | 'running' | 'completed' | 'partial' | 'failed'; progress: number; diagnostics: unknown; errorMessage: string | null; }

function mapRepository(row: typeof repositories.$inferSelect): DurableRepository { return { id: row.id, identity: { owner: row.owner, name: row.name, canonical: row.canonical }, defaultBranch: row.defaultBranch ?? 'main', description: row.description, sha: '', visibility: row.visibility }; }
function mapSnapshot(row: typeof snapshots.$inferSelect): DurableSnapshot { return { id: row.id, repoId: row.repositoryId, sha: row.commitSha, analyzerVersion: row.analyzerVersion, status: row.status, manifest: row.manifest, archiveKey: row.archiveKey, manifestKey: row.manifestKey, errorMessage: row.errorMessage }; }
function mapJob(row: typeof jobs.$inferSelect): DurableJob { return { id: row.id, snapshotId: row.snapshotId, type: row.type, status: row.status, stage: row.stage, progress: row.progress, attempts: row.attempts, errorMessage: row.errorMessage }; }

export async function submitSnapshot(db: Database, metadata: { identity: RepoIdentity; defaultBranch: string; description: string | null; sha: string; visibility: 'public' | 'private'; analyzerVersion: string }): Promise<Submission> {
  return db.transaction(async (tx) => {
    const [repo] = await tx.insert(repositories).values({ owner: metadata.identity.owner, name: metadata.identity.name, canonical: metadata.identity.canonical, defaultBranch: metadata.defaultBranch, description: metadata.description, visibility: metadata.visibility }).onConflictDoUpdate({ target: repositories.canonical, set: { defaultBranch: metadata.defaultBranch, description: metadata.description, updatedAt: new Date() } }).returning();
    if (!repo) throw new Error('Repository could not be persisted.');
    const [existing] = await tx.select().from(snapshots).where(and(eq(snapshots.repositoryId, repo.id), eq(snapshots.commitSha, metadata.sha), eq(snapshots.analyzerVersion, metadata.analyzerVersion))).limit(1);
    if (existing) {
      const [existingJob] = await tx.select().from(jobs).where(and(eq(jobs.snapshotId, existing.id), eq(jobs.type, 'ingest'))).orderBy(jobs.createdAt).limit(1);
      if (!existingJob) throw new Error('Snapshot exists without its ingestion job.');
      if (existingJob.status === 'failed') {
        const [retriedJob] = await tx.update(jobs).set({ status: 'queued', stage: 'resolving', progress: 0, errorMessage: null, updatedAt: new Date() }).where(eq(jobs.id, existingJob.id)).returning();
        if (!retriedJob) throw new Error('Failed ingestion job could not be retried.');
        return { repository: { ...mapRepository(repo), sha: metadata.sha }, snapshot: mapSnapshot(existing), job: mapJob(retriedJob), reused: false };
      }
      return { repository: { ...mapRepository(repo), sha: metadata.sha }, snapshot: mapSnapshot(existing), job: mapJob(existingJob), reused: true };
    }
    const [snapshot] = await tx.insert(snapshots).values({ repositoryId: repo.id, commitSha: metadata.sha, analyzerVersion: metadata.analyzerVersion, status: 'requested' }).returning();
    if (!snapshot) throw new Error('Snapshot could not be persisted.');
    const [job] = await tx.insert(jobs).values({ snapshotId: snapshot.id, type: 'ingest', status: 'queued', stage: 'resolving', progress: 0 }).returning();
    if (!job) throw new Error('Ingestion job could not be persisted.');
    return { repository: { ...mapRepository(repo), sha: metadata.sha }, snapshot: mapSnapshot(snapshot), job: mapJob(job), reused: false };
  });
}

export async function getJob(db: Database, id: string): Promise<DurableJob | undefined> { const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1); return row ? mapJob(row) : undefined; }
export async function getJobForSnapshot(db: Database, snapshotId: string): Promise<DurableJob | undefined> { const [row] = await db.select().from(jobs).where(and(eq(jobs.snapshotId, snapshotId), eq(jobs.type, 'ingest'))).orderBy(desc(jobs.createdAt)).limit(1); return row ? mapJob(row) : undefined; }
export async function getRepositoryByCanonical(db: Database, canonical: string): Promise<DurableRepository | undefined> { const [row] = await db.select().from(repositories).where(eq(repositories.canonical, canonical)).limit(1); return row ? mapRepository(row) : undefined; }
export async function getSnapshotById(db: Database, snapshotId: string): Promise<DurableSnapshot | undefined> { const [row] = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).limit(1); return row ? mapSnapshot(row) : undefined; }
export async function getSnapshotForRepository(db: Database, repositoryId: string, sha: string, analyzerVersion: string): Promise<DurableSnapshot | undefined> { const [row] = await db.select().from(snapshots).where(and(eq(snapshots.repositoryId, repositoryId), eq(snapshots.commitSha, sha), eq(snapshots.analyzerVersion, analyzerVersion))).limit(1); return row ? mapSnapshot(row) : undefined; }
export async function getLatestSnapshot(db: Database, repositoryId: string, analyzerVersion: string): Promise<DurableSnapshot | undefined> { const [row] = await db.select().from(snapshots).where(and(eq(snapshots.repositoryId, repositoryId), eq(snapshots.analyzerVersion, analyzerVersion))).orderBy(desc(snapshots.updatedAt)).limit(1); return row ? mapSnapshot(row) : undefined; }
export async function updateJob(db: Database, id: string, values: Partial<{ status: 'queued' | 'running' | 'completed' | 'failed'; stage: JobStage; progress: number; attempts: number; errorMessage: string | null }>): Promise<void> { await db.update(jobs).set({ ...values, updatedAt: new Date() }).where(eq(jobs.id, id)); }
export async function updateSnapshot(db: Database, id: string, values: Partial<{ status: SnapshotStatus; manifest: unknown; archiveKey: string; manifestKey: string; errorMessage: string | null }>): Promise<void> { await db.update(snapshots).set({ ...values, updatedAt: new Date() }).where(eq(snapshots.id, id)); }

export async function ensureAnalysisJob(db: Database, snapshotId: string, analyzerVersion: string, schemaVersion: string): Promise<DurableJob> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(jobs).where(and(eq(jobs.snapshotId, snapshotId), eq(jobs.type, 'analysis'))).limit(1);
    if (existing) {
      if (existing.status === 'failed') {
        const [retried] = await tx.update(jobs).set({ status: 'queued', stage: 'analysis', progress: 0, errorMessage: null, updatedAt: new Date() }).where(eq(jobs.id, existing.id)).returning();
        if (!retried) throw new Error('Failed analysis job could not be retried.');
        return mapJob(retried);
      }
      return mapJob(existing);
    }
    const [job] = await tx.insert(jobs).values({ snapshotId, type: 'analysis', status: 'queued', stage: 'analysis', progress: 0 }).returning();
    if (!job) throw new Error('Analysis job could not be persisted.');
    const [run] = await tx.select().from(analysisRuns).where(and(eq(analysisRuns.snapshotId, snapshotId), eq(analysisRuns.analyzerVersion, analyzerVersion), eq(analysisRuns.schemaVersion, schemaVersion))).limit(1);
    if (!run) await tx.insert(analysisRuns).values({ snapshotId, analyzerVersion, schemaVersion, status: 'queued', progress: 0 });
    return mapJob(job);
  });
}

export async function updateAnalysis(db: Database, snapshotId: string, analyzerVersion: string, schemaVersion: string, values: Partial<{ status: 'queued' | 'running' | 'completed' | 'partial' | 'failed'; progress: number; diagnostics: unknown; errorMessage: string | null }>): Promise<void> {
  await db.update(analysisRuns).set({ ...values, updatedAt: new Date() }).where(and(eq(analysisRuns.snapshotId, snapshotId), eq(analysisRuns.analyzerVersion, analyzerVersion), eq(analysisRuns.schemaVersion, schemaVersion)));
}

export async function getAnalysis(db: Database, snapshotId: string, analyzerVersion: string, schemaVersion: string): Promise<DurableAnalysis | undefined> {
  const [row] = await db.select().from(analysisRuns).where(and(eq(analysisRuns.snapshotId, snapshotId), eq(analysisRuns.analyzerVersion, analyzerVersion), eq(analysisRuns.schemaVersion, schemaVersion))).limit(1);
  return row ? { id: row.id, snapshotId: row.snapshotId, analyzerVersion: row.analyzerVersion, schemaVersion: row.schemaVersion, status: row.status, progress: row.progress, diagnostics: row.diagnostics, errorMessage: row.errorMessage } : undefined;
}

export async function getQueuedAnalysisJobs(db: Database) {
  const rows = await db.select({ job: jobs, snapshot: snapshots }).from(jobs).innerJoin(snapshots, eq(jobs.snapshotId, snapshots.id)).where(and(eq(jobs.type, 'analysis'), eq(jobs.status, 'queued'), eq(snapshots.status, 'ready')));
  return rows.map(({ job, snapshot }) => ({ job: mapJob(job), snapshot: { id: snapshot.id, sha: snapshot.commitSha, analyzerVersion: snapshot.analyzerVersion, archiveKey: snapshot.archiveKey, manifestKey: snapshot.manifestKey } }));
}

export async function persistAnalysis(db: Database, result: AnalysisResult): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(analysisRuns).where(and(eq(analysisRuns.snapshotId, result.snapshotId), eq(analysisRuns.analyzerVersion, result.analyzerVersion), eq(analysisRuns.schemaVersion, result.schemaVersion))).limit(1);
    if (!run) await tx.insert(analysisRuns).values({ snapshotId: result.snapshotId, analyzerVersion: result.analyzerVersion, schemaVersion: result.schemaVersion, status: result.diagnostics.length ? 'partial' : 'completed', progress: 100, diagnostics: result.diagnostics });
    else await tx.update(analysisRuns).set({ status: result.diagnostics.length ? 'partial' : 'completed', progress: 100, diagnostics: result.diagnostics, errorMessage: null, updatedAt: new Date() }).where(eq(analysisRuns.id, run.id));
    await tx.delete(graphEdges).where(and(eq(graphEdges.snapshotId, result.snapshotId), eq(graphEdges.analyzerVersion, result.analyzerVersion), eq(graphEdges.schemaVersion, result.schemaVersion)));
    await tx.delete(graphNodes).where(and(eq(graphNodes.snapshotId, result.snapshotId), eq(graphNodes.analyzerVersion, result.analyzerVersion), eq(graphNodes.schemaVersion, result.schemaVersion)));
    if (result.nodes.length) await tx.insert(graphNodes).values(result.nodes.map((node) => ({ id: node.id, snapshotId: node.snapshotId, analyzerVersion: node.analyzerVersion, schemaVersion: result.schemaVersion, nodeType: node.type, nodeKey: node.key, evidence: node.evidence ?? null })));
    if (result.edges.length) await tx.insert(graphEdges).values(result.edges.map((edge) => ({ id: edge.id, snapshotId: edge.snapshotId, analyzerVersion: edge.analyzerVersion, schemaVersion: result.schemaVersion, edgeType: edge.type, fromNodeId: edge.from, toNodeId: edge.to, resolution: edge.resolution, evidence: edge.evidence })));
  });
}

export async function getGraph(db: Database, snapshotId: string, analyzerVersion: string, schemaVersion: string, limit = 500) {
  const nodeRows = await db.select().from(graphNodes).where(and(eq(graphNodes.snapshotId, snapshotId), eq(graphNodes.analyzerVersion, analyzerVersion), eq(graphNodes.schemaVersion, schemaVersion))).limit(limit);
  const edgeRows = await db.select().from(graphEdges).where(and(eq(graphEdges.snapshotId, snapshotId), eq(graphEdges.analyzerVersion, analyzerVersion), eq(graphEdges.schemaVersion, schemaVersion))).limit(limit);
  const [run] = await db.select().from(analysisRuns).where(and(eq(analysisRuns.snapshotId, snapshotId), eq(analysisRuns.analyzerVersion, analyzerVersion), eq(analysisRuns.schemaVersion, schemaVersion))).orderBy(desc(analysisRuns.updatedAt)).limit(1);
  const nodes: GraphNode[] = nodeRows.map((node) => ({ id: node.id, type: node.nodeType as GraphNode['type'], snapshotId: node.snapshotId, analyzerVersion: node.analyzerVersion, key: node.nodeKey, evidence: node.evidence as GraphNode['evidence'] }));
  const edges: GraphEdge[] = edgeRows.map((edge) => ({ id: edge.id, type: edge.edgeType as GraphEdge['type'], snapshotId: edge.snapshotId, analyzerVersion: edge.analyzerVersion, from: edge.fromNodeId, to: edge.toNodeId, resolution: edge.resolution as GraphEdge['resolution'], evidence: edge.evidence as GraphEdge['evidence'] }));
  return { analysis: run, nodes, edges };
}

export async function getNodeNeighborhood(db: Database, snapshotId: string, analyzerVersion: string, schemaVersion: string, nodeId: string, limit = 50): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const edgeRows = await db.select().from(graphEdges).where(
    and(
      eq(graphEdges.snapshotId, snapshotId),
      eq(graphEdges.analyzerVersion, analyzerVersion),
      eq(graphEdges.schemaVersion, schemaVersion),
      or(eq(graphEdges.fromNodeId, nodeId), eq(graphEdges.toNodeId, nodeId))
    )
  ).limit(limit);

  const nodeIds = new Set<string>([nodeId]);
  for (const edge of edgeRows) {
    nodeIds.add(edge.fromNodeId);
    nodeIds.add(edge.toNodeId);
  }

  const nodeRows = nodeIds.size > 0 ? await db.select().from(graphNodes).where(
    and(
      eq(graphNodes.snapshotId, snapshotId),
      eq(graphNodes.analyzerVersion, analyzerVersion),
      eq(graphNodes.schemaVersion, schemaVersion),
      inArray(graphNodes.id, [...nodeIds])
    )
  ) : [];

  const nodes: GraphNode[] = nodeRows.map((node) => ({ id: node.id, type: node.nodeType as GraphNode['type'], snapshotId: node.snapshotId, analyzerVersion: node.analyzerVersion, key: node.nodeKey, evidence: node.evidence as GraphNode['evidence'] }));
  const edges: GraphEdge[] = edgeRows.map((edge) => ({ id: edge.id, type: edge.edgeType as GraphEdge['type'], snapshotId: edge.snapshotId, analyzerVersion: edge.analyzerVersion, from: edge.fromNodeId, to: edge.toNodeId, resolution: edge.resolution as GraphEdge['resolution'], evidence: edge.evidence as GraphEdge['evidence'] }));
  return { nodes, edges };
}
