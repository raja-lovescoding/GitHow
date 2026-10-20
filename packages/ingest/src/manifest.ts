import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import type { ManifestEntry } from '@gitflow/core';

export interface ArchiveLimits { maxArchiveBytes: number; maxExtractedBytes: number; maxFiles: number; maxFileBytes: number; }
export const defaultArchiveLimits: ArchiveLimits = { maxArchiveBytes: 250 * 1024 * 1024, maxExtractedBytes: 500 * 1024 * 1024, maxFiles: 100_000, maxFileBytes: 25 * 1024 * 1024 };

export const languageByExtension: Record<string, string> = {
  // TypeScript & JavaScript
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Python
  '.py': 'python',
  '.pyi': 'python',
  '.pyw': 'python',
  // Systems languages
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  // JVM
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.groovy': 'groovy',
  // Other popular languages
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.dart': 'dart',
  '.lua': 'lua',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  // Web & markup & styles
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.json': 'json',
  '.json5': 'json5',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.xml': 'xml',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
};

export const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pyc', '.pyo', '.class', '.o', '.a', '.obj',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.jar', '.war', '.ear',
]);

const wellKnownFilenames: Record<string, { language: string | null; classification: ManifestEntry['classification'] }> = {
  'dockerfile': { language: 'dockerfile', classification: 'source' },
  'containerfile': { language: 'dockerfile', classification: 'source' },
  'makefile': { language: 'makefile', classification: 'source' },
  'gemfile': { language: 'ruby', classification: 'source' },
  'rakefile': { language: 'ruby', classification: 'source' },
  'cmakelists.txt': { language: 'cmake', classification: 'source' },
  'package.json': { language: 'json', classification: 'source' },
  'tsconfig.json': { language: 'json', classification: 'source' },
  'cargo.toml': { language: 'toml', classification: 'source' },
  'pyproject.toml': { language: 'toml', classification: 'source' },
  'go.mod': { language: 'go', classification: 'source' },
  'go.sum': { language: null, classification: 'irrelevant' },
  'cargo.lock': { language: null, classification: 'irrelevant' },
  'package-lock.json': { language: 'json', classification: 'irrelevant' },
  'pnpm-lock.yaml': { language: 'yaml', classification: 'irrelevant' },
  'yarn.lock': { language: null, classification: 'irrelevant' },
};

const ignoredDirectories = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'vendor', '.next', '.turbo', '.venv', 'venv', 'target', '__pycache__']);

export function isBinaryExtension(extension: string): boolean {
  return binaryExtensions.has(extension.toLowerCase());
}

export function classifyPath(path: string, extension = ''): ManifestEntry['classification'] {
  const lower = path.toLowerCase();
  const filename = lower.split('/').pop() ?? '';
  if (wellKnownFilenames[filename]?.classification) {
    return wellKnownFilenames[filename].classification;
  }
  const ext = extension || (path.includes('.') ? `.${path.split('.').pop()!.toLowerCase()}` : '');
  if (isBinaryExtension(ext)) return 'binary';
  if (ignoredDirectories.has(lower.split('/')[0] ?? '') || lower.includes('/node_modules/') || lower.includes('/vendor/')) return 'vendor';
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.map') || lower.includes('/generated/') || lower.includes('/dist/') || lower.includes('/build/')) return 'generated';
  if (lower.endsWith('.lock') || lower.endsWith('.log') || lower.startsWith('.github/') || filename === '.ds_store' || filename === '.gitignore') return 'irrelevant';
  return 'source';
}

function detectLanguage(path: string, extension: string): string | null {
  const filename = path.split('/').pop()?.toLowerCase() ?? '';
  if (wellKnownFilenames[filename]?.language !== undefined) {
    return wellKnownFilenames[filename].language;
  }
  return languageByExtension[extension] ?? null;
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
      if (header.type === 'symlink' || header.type === 'link') throw new Error('Archive contains a link entry.');
      if (header.type !== 'file') { stream.resume(); stream.on('end', next); return; }
      if (header.size > limits.maxFileBytes) throw new Error('Repository contains a file larger than the configured limit.');
      if (entries.length >= limits.maxFiles) throw new Error('Repository contains more files than the configured limit.');
      const path = safePath(header.name);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) { size += (chunk as Buffer).length; extractedBytes += (chunk as Buffer).length; if (extractedBytes > limits.maxExtractedBytes) throw new Error('Repository exceeds the extracted-size limit.'); chunks.push(chunk as Buffer); }
      const content = Buffer.concat(chunks);
      const extension = path.includes('.') ? `.${path.split('.').pop()!.toLowerCase()}` : '';
      entries.push({ path, size, sha256: createHash('sha256').update(content).digest('hex'), extension, language: detectLanguage(path, extension), classification: classifyPath(path, extension) });
      next();
    })().catch((error) => extract.destroy(error));
  });
  const completion = new Promise<void>((resolve, reject) => { extract.once('finish', resolve); extract.once('error', reject); });
  Readable.from(archive).pipe(createGunzip()).pipe(extract);
  await completion;
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ExtractedSourceFile { path: string; content: string; }

export const supportedSourceLanguages = new Set(['typescript', 'javascript', 'python', 'go', 'rust']);

export function isSupportedSourceEntry(entry: ManifestEntry): boolean {
  return entry.classification === 'source' && entry.language !== null && supportedSourceLanguages.has(entry.language);
}

export async function extractSourceFiles(
  archive: Buffer,
  manifest: readonly ManifestEntry[],
  limits: ArchiveLimits = defaultArchiveLimits,
  filter?: (entry: ManifestEntry) => boolean,
): Promise<ExtractedSourceFile[]> {
  if (archive.byteLength > limits.maxArchiveBytes) throw new Error('Repository archive exceeds the configured download limit.');
  const isTarget = filter ?? isSupportedSourceEntry;
  const expected = new Map(manifest.filter(isTarget).map((entry) => [entry.path, entry]));
  const files = new Map<string, ExtractedSourceFile>();
  const extract = tar.extract();
  let extractedBytes = 0;
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      if (header.type === 'symlink' || header.type === 'link') throw new Error('Archive contains a link entry.');
      if (header.type !== 'file') { stream.resume(); stream.on('end', next); return; }
      const path = safePath(header.name);
      const entry = expected.get(path);
      if (!entry) { stream.resume(); stream.on('end', next); return; }
      if (header.size > limits.maxFileBytes || header.size !== entry.size) throw new Error(`Source file size does not match its manifest: ${path}`);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        extractedBytes += buffer.length;
        if (extractedBytes > limits.maxExtractedBytes) throw new Error('Repository exceeds the extracted-size limit.');
        chunks.push(buffer);
      }
      const content = Buffer.concat(chunks);
      if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error(`Source file hash does not match its manifest: ${path}`);
      files.set(path, { path, content: content.toString('utf8') });
      next();
    })().catch((error) => extract.destroy(error));
  });
  const completion = new Promise<void>((resolve, reject) => { extract.once('finish', resolve); extract.once('error', reject); });
  Readable.from(archive).pipe(createGunzip()).pipe(extract);
  await completion;
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
