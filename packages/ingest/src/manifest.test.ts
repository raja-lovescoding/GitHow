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

  it('recognizes multiple programming languages and classifies binary files', async () => {
    const pack = tar.pack();
    pack.entry({ name: 'repo-abc/src/app.py', type: 'file' }, 'def main(): pass');
    pack.entry({ name: 'repo-abc/main.go', type: 'file' }, 'package main');
    pack.entry({ name: 'repo-abc/Cargo.toml', type: 'file' }, '[package]\nname = "test"');
    pack.entry({ name: 'repo-abc/assets/logo.png', type: 'file' }, 'fake-png-binary-bytes');
    pack.entry({ name: 'repo-abc/Dockerfile', type: 'file' }, 'FROM node:20');
    pack.finalize();
    const chunks: Buffer[] = [];
    const buf = await new Promise<Buffer>((resolve, reject) => {
      pack.on('data', (chunk) => chunks.push(chunk as Buffer));
      pack.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
      pack.on('error', reject);
    });

    const manifest = await buildManifest(buf);
    const py = manifest.find((m) => m.path === 'src/app.py');
    const go = manifest.find((m) => m.path === 'main.go');
    const cargo = manifest.find((m) => m.path === 'Cargo.toml');
    const png = manifest.find((m) => m.path === 'assets/logo.png');
    const docker = manifest.find((m) => m.path === 'Dockerfile');

    expect(py).toMatchObject({ language: 'python', classification: 'source' });
    expect(go).toMatchObject({ language: 'go', classification: 'source' });
    expect(cargo).toMatchObject({ language: 'toml', classification: 'source' });
    expect(png).toMatchObject({ classification: 'binary' });
    expect(docker).toMatchObject({ language: 'dockerfile', classification: 'source' });
  });
});
