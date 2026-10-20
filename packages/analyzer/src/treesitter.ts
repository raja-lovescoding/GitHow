import { createRequire } from 'node:module';
import path from 'node:path';
import WebTreeSitter from 'web-tree-sitter';
import type { Diagnostic, SourceEvidence } from './model.js';

type TreeSitterParser = WebTreeSitter;
type TreeSitterLanguage = WebTreeSitter.Language;
type TreeSitterNode = WebTreeSitter.SyntaxNode;

let isInitialized = false;
let initPromise: Promise<void> | null = null;
const loadedLanguages = new Map<string, TreeSitterLanguage>();

const req = createRequire(import.meta.url);

export async function ensureTreeSitterInit(): Promise<void> {
  if (isInitialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const Parser = (WebTreeSitter as unknown as { default?: typeof WebTreeSitter }).default ?? WebTreeSitter;
    const wasmPath = path.join(path.dirname(req.resolve('web-tree-sitter/package.json')), 'tree-sitter.wasm');
    await Parser.init({
      locateFile: (file: string) => (file === 'tree-sitter.wasm' ? wasmPath : file),
    });
    isInitialized = true;
  })();
  return initPromise;
}

export async function getLanguageParser(languageName: 'python' | 'go' | 'rust'): Promise<{ parser: TreeSitterParser; language: TreeSitterLanguage }> {
  await ensureTreeSitterInit();
  const Parser = (WebTreeSitter as unknown as { default?: typeof WebTreeSitter }).default ?? WebTreeSitter;
  let language = loadedLanguages.get(languageName);
  if (!language) {
    const wasmsDir = path.join(path.dirname(req.resolve('tree-sitter-wasms/package.json')), 'out');
    const wasmFile = path.join(wasmsDir, `tree-sitter-${languageName}.wasm`);
    language = await Parser.Language.load(wasmFile);
    loadedLanguages.set(languageName, language);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  return { parser, language };
}

export function nodeEvidence(
  filePath: string,
  node: TreeSitterNode,
  name?: string,
  reason?: string,
  attributes?: Record<string, string | number | boolean>,
): SourceEvidence {
  const start = node.startPosition;
  const end = node.endPosition;
  return {
    path: filePath,
    startLine: start.row + 1,
    startColumn: start.column + 1,
    endLine: end.row + 1,
    endColumn: end.column + 1,
    ...(name ? { name } : {}),
    ...(reason ? { reason } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

export function collectDiagnostics(filePath: string, root: TreeSitterNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const walk = (node: TreeSitterNode) => {
    if (node.type === 'ERROR' || node.isMissing()) {
      diagnostics.push({
        path: filePath,
        message: node.isMissing() ? `Missing syntax element near line ${node.startPosition.row + 1}` : `Syntax error near line ${node.startPosition.row + 1}`,
        startLine: node.startPosition.row + 1,
        startColumn: node.startPosition.column + 1,
      });
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(root);
  return diagnostics;
}
