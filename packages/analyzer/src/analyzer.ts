import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { ManifestEntry } from '@gitflow/core';
import { analyzerVersion, graphSchemaVersion, type AnalysisResult, type Diagnostic, type GraphEdge, type GraphNode, type SourceEvidence } from './model.js';

export interface SourceFile { path: string; content: string; }
export interface AnalyzeInput { snapshotId: string; files: readonly SourceFile[]; manifest?: readonly ManifestEntry[]; analyzerVersion?: string; }

const supported = new Set(['.ts', '.tsx', '.js', '.jsx']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nodeId = (snapshot: string, type: string, key: string, version: string) => `rig_${hash(`${graphSchemaVersion}\0${version}\0${snapshot}\0${type}\0${key}`)}`;
const edgeId = (snapshot: string, type: string, from: string, to: string, version: string, evidence: SourceEvidence) => `rig_${hash(`${graphSchemaVersion}\0${version}\0${snapshot}\0${type}\0${from}\0${to}\0${evidence.path}\0${evidence.startLine}\0${evidence.startColumn}`)}`;

function evidence(sourceFile: string, source: ts.SourceFile, node: ts.Node, name?: string, reason?: string): SourceEvidence {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.end);
  return { path: sourceFile, startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1, ...(name ? { name } : {}), ...(reason ? { reason } : {}) };
}
function addNode(nodes: Map<string, GraphNode>, snapshotId: string, type: GraphNode['type'], key: string, version: string, ev?: SourceEvidence): string {
  const id = nodeId(snapshotId, type, key, version);
  nodes.set(id, { id, type, snapshotId, analyzerVersion: version, key, ...(ev ? { evidence: ev } : {}) });
  return id;
}
function addEdge(edges: Map<string, GraphEdge>, snapshotId: string, type: GraphEdge['type'], from: string, to: string, resolution: GraphEdge['resolution'], version: string, ev: SourceEvidence) {
  const id = edgeId(snapshotId, type, from, to, version, ev);
  edges.set(id, { id, type, snapshotId, analyzerVersion: version, from, to, resolution, evidence: ev });
}
function symbolName(node: ts.Node): string | undefined {
  const name = (node as ts.NamedDeclaration).name;
  if (name && ts.isIdentifier(name)) return name.text;
  return undefined;
}

export function analyzeRepository(input: AnalyzeInput): AnalysisResult {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const diagnostics: Diagnostic[] = [];
  const version = input.analyzerVersion ?? analyzerVersion;
  const files = input.files.filter((file) => supported.has(file.path.slice(file.path.lastIndexOf('.')).toLowerCase())).sort((a, b) => a.path.localeCompare(b.path));
  const snapshotNode = addNode(nodes, input.snapshotId, 'snapshot', input.snapshotId, version);
  const declarations = new Map<string, string>();
  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, file.path.endsWith('x') ? ts.ScriptKind.TSX : file.path.endsWith('.ts') ? ts.ScriptKind.TS : file.path.endsWith('jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
    const fileId = addNode(nodes, input.snapshotId, 'file', file.path, version, { path: file.path, startLine: 1, startColumn: 1, endLine: source.getLineAndCharacterOfPosition(source.end).line + 1, endColumn: source.getLineAndCharacterOfPosition(source.end).character + 1 });
    addEdge(edges, input.snapshotId, 'CONTAINS', snapshotNode, fileId, 'observed', version, { path: file.path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 });
    const visit = (node: ts.Node, parentSymbol?: string) => {
      let current = parentSymbol;
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
        const name = symbolName(node) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
        if (name) {
          const key = `${file.path}:${node.pos}:${name}`;
          const ev = evidence(file.path, source, node, name);
          const id = addNode(nodes, input.snapshotId, 'symbol', key, version, ev);
          addEdge(edges, input.snapshotId, 'DECLARES', fileId, id, 'observed', version, ev);
          current = id;
          declarations.set(`${file.path}:${name}`, id);
          if (ts.isClassDeclaration(node)) {
            for (const heritage of node.heritageClauses ?? []) for (const type of heritage.types) {
              const target = type.expression.getText(source);
              const targetId = declarations.get(`${file.path}:${target}`);
              const resolvedTargetId = targetId ?? addNode(nodes, input.snapshotId, 'symbol', `unresolved:${target}`, version, evidence(file.path, source, type, target, 'target declaration is not available'));
              addEdge(edges, input.snapshotId, heritage.token === ts.SyntaxKind.ExtendsKeyword ? 'EXTENDS' : 'IMPLEMENTS', id, resolvedTargetId, targetId ? 'resolved' : 'unresolved', version, evidence(file.path, source, type, target, targetId ? undefined : 'target declaration is not available'));
            }
          }
        }
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const name = node.name.text;
        const ev = evidence(file.path, source, node, name);
        const id = addNode(nodes, input.snapshotId, 'symbol', `${file.path}:${node.pos}:${name}`, version, ev);
        addEdge(edges, input.snapshotId, 'DECLARES', fileId, id, 'observed', version, ev);
        current = id;
        declarations.set(`${file.path}:${name}`, id);
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveRelative(file.path, node.moduleSpecifier.text, files.map((item) => item.path));
        const targetId = target ? addNode(nodes, input.snapshotId, 'file', target, version) : addNode(nodes, input.snapshotId, 'module', `unresolved:${node.moduleSpecifier.text}`, version);
        addEdge(edges, input.snapshotId, 'IMPORTS', fileId, targetId, target ? 'resolved' : 'unresolved', version, evidence(file.path, source, node.moduleSpecifier, node.moduleSpecifier.text, target ? undefined : 'relative module was not found'));
      }
      const requireArgument = ts.isCallExpression(node) && node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && requireArgument && ts.isStringLiteral(requireArgument)) {
        const specifier = requireArgument.text;
        const target = resolveRelative(file.path, specifier, files.map((item) => item.path));
        const targetId = target ? addNode(nodes, input.snapshotId, 'file', target, version) : addNode(nodes, input.snapshotId, 'module', `unresolved:${specifier}`, version);
        addEdge(edges, input.snapshotId, 'IMPORTS', fileId, targetId, target ? 'resolved' : 'unresolved', version, evidence(file.path, source, requireArgument, specifier, target ? undefined : 'relative module was not found'));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left;
        const isCommonJsExport = ts.isPropertyAccessExpression(left) && ((ts.isIdentifier(left.expression) && left.expression.text === 'module' && left.name.text === 'exports') || (ts.isIdentifier(left.expression) && left.expression.text === 'exports'));
        if (isCommonJsExport) addEdge(edges, input.snapshotId, 'EXPORTS', fileId, current ?? fileId, 'observed', version, evidence(file.path, source, left));
      }
      if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0) {
        addEdge(edges, input.snapshotId, 'EXPORTS', fileId, current ?? fileId, 'observed', version, evidence(file.path, source, node, symbolName(node)));
      }
      if (ts.isCallExpression(node) && current) {
        const targetName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
        const targetId = targetName ? declarations.get(`${file.path}:${targetName}`) : undefined;
        const callTargetId = targetId ?? addNode(nodes, input.snapshotId, 'symbol', `unresolved-call:${file.path}:${node.pos}`, version, evidence(file.path, source, node, targetName, 'call target is not statically identifiable'));
        addEdge(edges, input.snapshotId, 'CALLS', current, callTargetId, targetId ? 'resolved' : 'unresolved', version, evidence(file.path, source, node, targetName, targetId ? undefined : 'call target is not statically identifiable'));
      }
      ts.forEachChild(node, (child) => visit(child, current));
    };
    const collectDeclarations = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
        const name = symbolName(node) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
        if (name) declarations.set(`${file.path}:${name}`, nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${name}`, version));
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        declarations.set(`${file.path}:${node.name.text}`, nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${node.name.text}`, version));
      }
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(source);
    visit(source);
    const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    for (const diagnostic of parseDiagnostics) {
      const start = diagnostic.start ?? 0;
      const pos = source.getLineAndCharacterOfPosition(start);
      diagnostics.push({ path: file.path, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '), startLine: pos.line + 1, startColumn: pos.character + 1 });
    }
  }
  return { schemaVersion: graphSchemaVersion, analyzerVersion: version, snapshotId: input.snapshotId, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)), diagnostics: diagnostics.sort((a, b) => `${a.path}:${a.startLine ?? 0}`.localeCompare(`${b.path}:${b.startLine ?? 0}`)) };
}

function resolveRelative(from: string, specifier: string, paths: readonly string[]): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = normalizePath(`${from.slice(0, from.lastIndexOf('/') + 1)}${specifier}`);
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx'].map((ext) => `${base}${ext}`), ...['.ts', '.tsx', '.js', '.jsx'].map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => paths.includes(candidate));
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}
