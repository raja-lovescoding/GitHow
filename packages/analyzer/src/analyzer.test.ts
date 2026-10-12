import { describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';

describe('analyzeRepository', () => {
  it('extracts deterministic source-backed declarations and relative imports', () => {
    const files = [
      { path: 'src/main.ts', content: "import { helper } from './helper'; export function main() { return helper(); }" },
      { path: 'src/helper.ts', content: 'export const helper = () => 1;' },
    ];
    const first = analyzeRepository({ snapshotId: 'snapshot-1', files });
    const second = analyzeRepository({ snapshotId: 'snapshot-1', files: [...files].reverse() });
    expect(second).toEqual(first);
    expect(first.nodes.some((node) => node.type === 'symbol' && node.evidence?.name === 'main')).toBe(true);
    expect(first.edges.some((edge) => edge.type === 'IMPORTS' && edge.resolution === 'resolved')).toBe(true);
  });

  it('retains parse diagnostics without discarding other files', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-2', files: [{ path: 'broken.ts', content: 'function broken( {' }, { path: 'ok.ts', content: 'export function ok() {}' }] });
    expect(result.diagnostics.some((diagnostic) => diagnostic.path === 'broken.ts')).toBe(true);
    expect(result.nodes.some((node) => node.evidence?.path === 'ok.ts' && node.evidence.name === 'ok')).toBe(true);
  });

  it('observes CommonJS require and exports', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-3', files: [{ path: 'src/main.js', content: "const helper = require('./helper'); module.exports = helper;" }, { path: 'src/helper.js', content: 'module.exports = () => 1;' }] });
    expect(result.edges.some((edge) => edge.type === 'IMPORTS' && edge.resolution === 'resolved')).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'EXPORTS')).toBe(true);
  });

  it('captures direct symbol-to-symbol call relationships', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-4', files: [{ path: 'src/index.ts', content: 'export function helper() { return 1; } export function main() { return helper(); }' }] });
    expect(result.edges.some((edge) => edge.type === 'CALLS' && edge.resolution === 'resolved')).toBe(true);
    expect(result.nodes.some((node) => node.type === 'symbol' && node.evidence?.name === 'main')).toBe(true);
  });
});
