import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import type { ManifestEntry } from '@gitflow/core';

export interface ArchiveLimits { maxArchiveBytes: number; maxExtractedBytes: number; maxFiles: number; maxFileBytes: number; }
export const defaultArchiveLimits: ArchiveLimits = { maxArchiveBytes: 250 * 1024 * 1024, maxExtractedBytes: 500 * 1024 * 1024, maxFiles: 100_000, maxFileBytes: 25 * 1024 * 1024 };

const languageByExtension: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.css': 'css', '.md': 'markdown' };
const ignoredDirectories = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'vendor']);

export function classifyPath(path: string): ManifestEntry['classification'] {
  const lower = path.toLowerCase();
  if (ignoredDirectories.has(lower.split('/')[0] ?? '') || lower.includes('/node_modules/')) return 'vendor';
  if (lower.endsWith('.min.js') || lower.endsWith('.map') || lower.includes('/generated/')) return 'generated';
  if (lower.endsWith('.lock') || lower.endsWith('.log') || lower.startsWith('.github/')) return 'irrelevant';
  return 'source';
}

function safePath(rawPath: string): string {
  const normalized = rawPath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '.')) throw new Error('Archive contains an unsafe path.');
  const parts = normalized.split('/');
  if (parts.length < 2) throw new Error('Archive entry is missing its repository root.');
  const relative = parts.slice(1).join('/');
  if (!relative || relative.split('/').some((part) => part === '..' || part === '.')) throw new Error('Archive contains an unsafe path.');
  return relative;
}

export async function buildManifest(archive: Buffer, limits: ArchiveLimits = defaultArchiveLimits): Promise<ManifestEntry[]> {
  if (archive.byteLength > limits.maxArchiveBytes) throw new Error('Repository archive exceeds the configured download limit.');
  const extract = tar.extract();
  const entries: ManifestEntry[] = [];
  let extractedBytes = 0;
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      if (header.type !== 'file') { stream.resume(); stream.on('end', next); return; }
      if (header.size > limits.maxFileBytes) throw new Error('Repository contains a file larger than the configured limit.');
      if (entries.length >= limits.maxFiles) throw new Error('Repository contains more files than the configured limit.');
      const path = safePath(header.name);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) { size += (chunk as Buffer).length; extractedBytes += (chunk as Buffer).length; if (extractedBytes > limits.maxExtractedBytes) throw new Error('Repository exceeds the extracted-size limit.'); chunks.push(chunk as Buffer); }
      const content = Buffer.concat(chunks);
      const extension = path.includes('.') ? `.${path.split('.').pop()!.toLowerCase()}` : '';
      entries.push({ path, size, sha256: createHash('sha256').update(content).digest('hex'), extension, language: languageByExtension[extension] ?? null, classification: classifyPath(path) });
      next();
    })().catch((error) => extract.destroy(error));
  });
  const completion = new Promise<void>((resolve, reject) => { extract.once('finish', resolve); extract.once('error', reject); });
  Readable.from(archive).pipe(createGunzip()).pipe(extract);
  await completion;
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
