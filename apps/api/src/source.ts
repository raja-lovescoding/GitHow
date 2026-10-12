import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import type { ManifestEntry } from '@gitflow/core';
import type { ObjectStorage } from '@gitflow/storage';

export interface SnapshotRecordLike {
  id: string;
  archiveKey: string | null;
  manifestKey: string | null;
  manifest: unknown;
}

export interface SourceFileResponse {
  path: string;
  content: string;
  language: string | null;
  bytes: number;
  lineCount: number;
}

function safeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('./')) throw new Error('Source paths must be relative to the repository root.');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '.' || !part)) throw new Error('Source paths must not include traversal segments.');
  return normalized;
}

async function readArchiveTarget(archive: Buffer, relativePath: string, expectedSize: number, expectedSha256: string): Promise<string> {
  const target = relativePath.replace(/^\//, '');
  const extract = tar.extract();
  let result: string | null = null;
  return new Promise<string>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      void (async () => {
        if (header.type !== 'file') { stream.resume(); stream.on('end', next); return; }
        const name = header.name.replaceAll('\\', '/');
        const parts = name.split('/');
        if (parts.length >= 2) {
          const repoPath = parts.slice(1).join('/');
          if (repoPath === target) {
            if (header.size !== expectedSize) throw new Error(`Source file size does not match its manifest: ${relativePath}`);
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              size += (chunk as Uint8Array).byteLength;
              if (size > expectedSize) throw new Error(`Source file exceeds its manifest size: ${relativePath}`);
              chunks.push(Buffer.from(chunk as Uint8Array));
            }
            if (size !== expectedSize) throw new Error(`Source file size does not match its manifest: ${relativePath}`);
            const content = Buffer.concat(chunks);
            if (createHash('sha256').update(content).digest('hex') !== expectedSha256) {
              throw new Error(`Source file hash does not match its manifest: ${relativePath}`);
            }
            result = content.toString('utf8');
            next();
            return;
          }
        }
        stream.resume(); stream.on('end', next);
      })().catch((error) => extract.destroy(error));
    });
    extract.on('error', reject);
    extract.on('finish', () => {
      if (result === null) reject(new Error(`Source file not found in archive: ${relativePath}`));
      else resolve(result);
    });
    Readable.from(archive).pipe(createGunzip()).pipe(extract);
  }) as unknown as Promise<string>;
}

export function createSnapshotSourceReader({ storage, getSnapshot }: { storage: ObjectStorage; getSnapshot: (snapshotId: string) => Promise<SnapshotRecordLike | undefined>; }) {
  return {
    async getManifest(snapshotId: string): Promise<ManifestEntry[]> {
      const snapshot = await getSnapshot(snapshotId);
      if (!snapshot || !snapshot.manifestKey) return [];
      const manifest = await storage.get(snapshot.manifestKey);
      return JSON.parse(manifest.toString('utf8')) as ManifestEntry[];
    },
    async getSource(snapshotId: string, relativePath: string): Promise<SourceFileResponse> {
      const snapshot = await getSnapshot(snapshotId);
      if (!snapshot || !snapshot.archiveKey || !snapshot.manifestKey) throw new Error('Source could not be resolved for this snapshot.');
      const relative = safeRelativePath(relativePath);
      const manifest = JSON.parse((await storage.get(snapshot.manifestKey)).toString('utf8')) as ManifestEntry[];
      const match = manifest.find((entry) => entry.path === relative && entry.classification === 'source' && ['typescript', 'javascript'].includes(entry.language ?? ''));
      if (!match) throw new Error('Only TypeScript and JavaScript source files from the immutable snapshot can be viewed.');
      const archive = await storage.get(snapshot.archiveKey);
      const content = await readArchiveTarget(archive, relative, match.size, match.sha256);
      return { path: relative, content, language: match.language, bytes: match.size, lineCount: content.split(/\r?\n/).length };
    },
  };
}
