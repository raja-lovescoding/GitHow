import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { buildManifest, extractSourceFiles } from './manifest.js';

function archive(name: string, content: string) {
  const pack = tar.pack(); pack.entry({ name: `repo-abc/${name}`, type: 'file' }, content); pack.finalize();
  return new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; pack.on('data', (chunk) => chunks.push(chunk as Buffer)); pack.on('end', () => resolve(gzipSync(Buffer.concat(chunks)))); pack.on('error', reject); });
}

describe('safe archive manifest', () => {
  it('hashes files and removes the GitHub root directory', async () => { const result = await buildManifest(await archive('src/index.ts', 'export {}')); expect(result[0]).toMatchObject({ path: 'src/index.ts', language: 'typescript', classification: 'source', size: 9 }); });
  it('rejects traversal paths', async () => { await expect(buildManifest(await archive('../escape.ts', 'bad'))).rejects.toThrow('unsafe path'); });
  it('enforces file limits', async () => { await expect(buildManifest(await archive('large.ts', '12345'), { maxArchiveBytes: 1_000_000, maxExtractedBytes: 1_000_000, maxFiles: 10, maxFileBytes: 2 })).rejects.toThrow('larger'); });
  it('extracts only manifest-backed source files and verifies their hash', async () => {
    const input = await archive('src/index.ts', 'export {}');
    const manifest = await buildManifest(input);
    await expect(extractSourceFiles(input, manifest)).resolves.toEqual([{ path: 'src/index.ts', content: 'export {}' }]);
  });
});
