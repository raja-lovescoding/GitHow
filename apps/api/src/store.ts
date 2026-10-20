import type { ManifestEntry, RepoIdentity, SnapshotStatus, JobStage } from '@gitflow/core';
import { randomUUID } from 'node:crypto';
export interface RepoRecord { id: string; identity: RepoIdentity; defaultBranch: string; description: string | null; sha: string; visibility: 'public' | 'private'; }
export interface SnapshotRecord { id: string; repoId: string; sha: string; status: SnapshotStatus; manifest: ManifestEntry[]; errorMessage?: string; }
export interface JobRecord { id: string; snapshotId: string; status: 'queued' | 'running' | 'completed' | 'failed'; stage: JobStage; progress: number; errorMessage?: string; }
export class AnalysisStore {
  readonly repos = new Map<string, RepoRecord>(); readonly snapshots = new Map<string, SnapshotRecord>(); readonly jobs = new Map<string, JobRecord>();
  findSnapshot(canonical: string, sha: string) { const repo = this.repos.get(canonical); return repo ? [...this.snapshots.values()].find((snapshot) => snapshot.repoId === repo.id && snapshot.sha === sha) : undefined; }
  create(repo: Omit<RepoRecord, 'id'>, sha: string) { const existingRepo = this.repos.get(repo.identity.canonical); const savedRepo = existingRepo ?? { ...repo, id: randomUUID(), sha }; this.repos.set(repo.identity.canonical, savedRepo); const existing = this.findSnapshot(repo.identity.canonical, sha); if (existing) return { repo: savedRepo, snapshot: existing, job: [...this.jobs.values()].find((job) => job.snapshotId === existing.id), reused: true };
    const snapshot: SnapshotRecord = { id: randomUUID(), repoId: savedRepo.id, sha, status: 'requested', manifest: [] }; const job: JobRecord = { id: randomUUID(), snapshotId: snapshot.id, status: 'queued', stage: 'resolving', progress: 0 }; this.snapshots.set(snapshot.id, snapshot); this.jobs.set(job.id, job); return { repo: savedRepo, snapshot, job, reused: false };
  }
}
