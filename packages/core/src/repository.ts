import { z } from 'zod';

export const repositoryNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export const repoIdentitySchema = z.object({
  owner: z.string().regex(repositoryNamePattern),
  name: z.string().regex(repositoryNamePattern),
  canonical: z.string(),
});
export type RepoIdentity = z.infer<typeof repoIdentitySchema>;

const reservedPaths = new Set(['about', 'pricing', 'docs', 'api', '_next', '_auth', '_share']);

export function normalizeGitHubRepository(input: string): RepoIdentity {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a valid GitHub repository URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) GitHub URLs are supported.');
  if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') throw new Error('Only github.com URLs are supported.');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) throw new Error('Use a repository URL in the form https://github.com/owner/repository.');
  return parseRepositoryPath(segments);
}

export function parseRepositoryPath(segments: readonly string[]): RepoIdentity {
  if (segments.length !== 2) throw new Error('Repository routes require exactly an owner and repository name.');
  const [owner, name] = segments;
  if (!owner || !name || reservedPaths.has(owner.toLowerCase()) || reservedPaths.has(name.toLowerCase())) throw new Error('That path is reserved or is not a repository.');
  if (!repositoryNamePattern.test(owner) || !repositoryNamePattern.test(name)) throw new Error('Repository names contain unsupported characters.');
  const normalizedOwner = owner.toLowerCase();
  const normalizedName = name.toLowerCase().replace(/\.git$/, '');
  return { owner: normalizedOwner, name: normalizedName, canonical: `${normalizedOwner}/${normalizedName}` };
}

export const snapshotStatusSchema = z.enum(['requested', 'resolving', 'fetching', 'processing', 'ready', 'failed']);
export type SnapshotStatus = z.infer<typeof snapshotStatusSchema>;
export const jobStageSchema = z.enum(['resolving', 'fetching', 'manifest', 'storing', 'analysis', 'complete']);
export type JobStage = z.infer<typeof jobStageSchema>;
export const manifestEntrySchema = z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string(), extension: z.string(), language: z.string().nullable(), classification: z.enum(['source', 'binary', 'generated', 'vendor', 'irrelevant']) });
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
