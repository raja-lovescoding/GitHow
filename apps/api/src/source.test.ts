import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { createSnapshotSourceReader } from './source.js';

async function createArchive(path: string, content: string): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name: `repo-root/${path}`, type: 'file' }, content);
  pack.finalize();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    pack.on('data', (chunk) => chunks.push(chunk as Buffer));
    pack.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on('error', reject);
  });
}

describe('snapshot source reader', () => {
  it('returns manifest-backed content and verifies its immutable hash', async () => {
    const content = 'export function answer() { return 42; }\n';
    const archiveBuffer = await createArchive('src/index.ts', content);
    const expectedHash = createHash('sha256').update(content).digest('hex');
    const reader = createSnapshotSourceReader({
      storage: {
        get: async (key: string) => key.endsWith('manifest.json') ? Buffer.from(JSON.stringify([{
          path: 'src/index.ts',
          size: Buffer.byteLength(content),
          sha256: '0'.repeat(64),
          extension: '.ts',
          language: 'typescript',
          classification: 'source',
        }])) : archiveBuffer,
      } as never,
      getSnapshot: async () => ({ id: 'snapshot-1', archiveKey: 'archive.tar.gz', manifestKey: 'manifest.json', manifest: [] }),
    });

    const manifest = JSON.stringify([{
      path: 'src/index.ts',
      size: Buffer.byteLength(content),
      sha256: expectedHash,
      extension: '.ts',
      language: 'typescript',
      classification: 'source',
    }]);
    const validReader = createSnapshotSourceReader({
      storage: { get: async (key: string) => key.endsWith('manifest.json') ? Buffer.from(manifest) : archiveBuffer } as never,
      getSnapshot: async () => ({ id: 'snapshot-1', archiveKey: 'archive.tar.gz', manifestKey: 'manifest.json', manifest: [] }),
    });

    await expect(validReader.getSource('snapshot-1', 'src/index.ts')).resolves.toMatchObject({ path: 'src/index.ts', content });
    await expect(validReader.getSource('snapshot-1', '../escape.ts')).rejects.toThrow('traversal');
    await expect(reader.getSource('snapshot-1', 'src/index.ts')).rejects.toThrow('hash');
  });
});
