import { Octokit } from 'octokit';
import { Readable } from 'node:stream';
import type { RepoIdentity } from '@gitflow/core';

export class GitHubRepositoryError extends Error { constructor(public readonly code: 'not_found_or_private' | 'rate_limited' | 'network', message: string) { super(message); } }
export interface RepositoryMetadata { identity: RepoIdentity; description: string | null; defaultBranch: string; visibility: 'public' | 'private'; sha: string; }

export function createGitHubClient(token?: string) { return new Octokit(token ? { auth: token } : undefined); }

export async function resolveRepository(client: Octokit, identity: RepoIdentity): Promise<RepositoryMetadata> {
  try {
    const repo = await client.rest.repos.get({ owner: identity.owner, repo: identity.name });
    if (repo.data.private) throw new GitHubRepositoryError('not_found_or_private', 'This repository is private or unavailable without authorization.');
    const commit = await client.rest.repos.getBranch({ owner: identity.owner, repo: identity.name, branch: repo.data.default_branch });
    return { identity, description: repo.data.description, defaultBranch: repo.data.default_branch, visibility: 'public', sha: commit.data.commit.sha };
  } catch (error) {
    if (error instanceof GitHubRepositoryError) throw error;
    const status = (error as { status?: number }).status;
    if (status === 403 || status === 429) throw new GitHubRepositoryError('rate_limited', 'GitHub rate limit reached. Please try again later.');
    if (status === 404) throw new GitHubRepositoryError('not_found_or_private', 'Repository not found or private.');
    throw new GitHubRepositoryError('network', 'GitHub could not be reached. Please try again later.');
  }
}

export async function downloadArchive(client: Octokit, identity: RepoIdentity, sha: string): Promise<Buffer> {
  const response = await client.request('GET /repos/{owner}/{repo}/tarball/{ref}', { owner: identity.owner, repo: identity.name, ref: sha, mediaType: { format: 'application/vnd.github+json' } });
  const data = response.data as unknown;
  const length = Number(response.headers['content-length'] ?? 0);
  if (length > 250 * 1024 * 1024) throw new Error('Repository archive exceeds the configured download limit.');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === 'object' && data !== null && 'arrayBuffer' in data && typeof data.arrayBuffer === 'function') return Buffer.from(await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer());
  if (typeof data === 'object' && data !== null && Symbol.asyncIterator in data) { const chunks: Buffer[] = []; let total = 0; for await (const chunk of data as AsyncIterable<Uint8Array>) { total += chunk.byteLength; if (total > 250 * 1024 * 1024) throw new Error('Repository archive exceeds the configured download limit.'); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks); }
  if (data instanceof Readable) { const chunks: Buffer[] = []; let total = 0; for await (const chunk of data) { const buffer = Buffer.from(chunk as Uint8Array); total += buffer.byteLength; if (total > 250 * 1024 * 1024) throw new Error('Repository archive exceeds the configured download limit.'); chunks.push(buffer); } return Buffer.concat(chunks); }
  throw new Error('GitHub returned an unsupported archive response.');
}
