import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { ManifestEntry } from '@gitflow/core';
import { analyzerVersion, graphSchemaVersion, type AnalysisResult, type Diagnostic, type GraphEdge, type GraphNode, type SourceEvidence } from './model.js';
import { AnalyzerRegistry } from './adapter.js';
import { PythonLanguageAdapter } from './adapters/python.js';
import { GoLanguageAdapter } from './adapters/go.js';
import { RustLanguageAdapter } from './adapters/rust.js';
import { resolveTsModule } from './resolution.js';
import { analyzeTsDataFlow, type FunctionDataFlowSignature } from './dataflow.js';
import {
  extractExpressFramework,
  extractFastifyFramework,
  ExpressFrameworkAdapter,
  FastifyFrameworkAdapter,
  FlaskFrameworkAdapter,
  FastApiFrameworkAdapter,
  GinFrameworkAdapter,
  ActixWebFrameworkAdapter,
  AxumFrameworkAdapter,
} from './frameworks/index.js';

export interface SourceFile { path: string; content: string; }
export interface AnalyzeInput { snapshotId: string; files: readonly SourceFile[]; manifest?: readonly ManifestEntry[]; analyzerVersion?: string; }

export function createDefaultAnalyzerRegistry(): AnalyzerRegistry {
  const registry = new AnalyzerRegistry();
  registry.registerLanguageAdapter(new PythonLanguageAdapter());
  registry.registerLanguageAdapter(new GoLanguageAdapter());
  registry.registerLanguageAdapter(new RustLanguageAdapter());

  registry.registerFrameworkAdapter(new ExpressFrameworkAdapter());
  registry.registerFrameworkAdapter(new FastifyFrameworkAdapter());
  registry.registerFrameworkAdapter(new FlaskFrameworkAdapter());
  registry.registerFrameworkAdapter(new FastApiFrameworkAdapter());
  registry.registerFrameworkAdapter(new GinFrameworkAdapter());
  registry.registerFrameworkAdapter(new ActixWebFrameworkAdapter());
  registry.registerFrameworkAdapter(new AxumFrameworkAdapter());
  return registry;
}

const supported = new Set(['.ts', '.tsx', '.js', '.jsx']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nodeId = (snapshot: string, type: string, key: string, version: string) => `rig_${hash(`${graphSchemaVersion}\0${version}\0${snapshot}\0${type}\0${key}`)}`;
const edgeId = (snapshot: string, type: string, from: string, to: string, version: string, evidence: SourceEvidence) => `rig_${hash(`${graphSchemaVersion}\0${version}\0${snapshot}\0${type}\0${from}\0${to}\0${evidence.path}\0${evidence.startLine}\0${evidence.startColumn}`)}`;

function evidence(sourceFile: string, source: ts.SourceFile, node: ts.Node, name?: string, reason?: string): SourceEvidence {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.end);
  return { path: sourceFile, startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1, ...(name ? { name } : {}), ...(reason ? { reason } : {}) };
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
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

interface ReexportEntry {
  filePath: string;
  moduleSpecifier: string;
  isStar?: boolean;
  namespace?: string;
  elements?: Array<{ exportName: string; localName: string }>;
}

export async function analyzeRepository(input: AnalyzeInput): Promise<AnalysisResult> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const diagnostics: Diagnostic[] = [];
  const version = input.analyzerVersion ?? analyzerVersion;
  const files = input.files.filter((file) => supported.has(file.path.slice(file.path.lastIndexOf('.')).toLowerCase())).sort((a, b) => a.path.localeCompare(b.path));
  const allFilesSet = new Set(input.files.map((f) => f.path));
  const snapshotNode = addNode(nodes, input.snapshotId, 'snapshot', input.snapshotId, version);

  const declarations = new Map<string, string>();
  const variableClassTypes = new Map<string, string>();
  const importedBindings = new Map<string, string>();
  const exportedBindings = new Map<string, string>();
  const parsedSources: Array<{ file: SourceFile; source: ts.SourceFile; fileId: string }> = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith('x') ? ts.ScriptKind.TSX : file.path.endsWith('.ts') ? ts.ScriptKind.TS : file.path.endsWith('jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS
    );
    const fileId = addNode(nodes, input.snapshotId, 'file', file.path, version, {
      path: file.path,
      startLine: 1,
      startColumn: 1,
      endLine: source.getLineAndCharacterOfPosition(source.end).line + 1,
      endColumn: source.getLineAndCharacterOfPosition(source.end).character + 1,
    });
    parsedSources.push({ file, source, fileId });
    addEdge(edges, input.snapshotId, 'CONTAINS', snapshotNode, fileId, 'observed', version, { path: file.path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 });

    const collectDeclarations = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        const className = symbolName(node);
        if (className) {
          const classNodeId = nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${className}`, version);
          declarations.set(`${file.path}:${className}`, classNodeId);
          for (const member of node.members) {
            if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name && ts.isIdentifier(member.name)) {
              const mName = member.name.text;
              const mId = nodeId(input.snapshotId, 'symbol', `${file.path}:${member.pos}:${className}.${mName}`, version);
              declarations.set(`${file.path}:${className}.${mName}`, mId);
              if (!declarations.has(`${file.path}:${mName}`)) {
                declarations.set(`${file.path}:${mName}`, mId);
              }
            }
          }
        }
      } else if (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isConstructorDeclaration(node)) {
        const name = symbolName(node) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
        if (name) declarations.set(`${file.path}:${name}`, nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${name}`, version));
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer) || ts.isNewExpression(node.initializer)) {
          declarations.set(`${file.path}:${node.name.text}`, nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${node.name.text}`, version));
        }
        if (ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
          variableClassTypes.set(`${file.path}:${node.name.text}`, node.initializer.expression.text);
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.name)) {
          const propName = node.left.name.text;
          const expr = node.left.expression;
          const isExports =
            (ts.isIdentifier(expr) && expr.text === 'exports') ||
            (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'module' && expr.name.text === 'exports');
          if (isExports) {
            declarations.set(`${file.path}:${propName}`, nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${propName}`, version));
          }
        }
      }
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(source);

    const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    for (const diagnostic of parseDiagnostics) {
      const start = diagnostic.start ?? 0;
      const pos = source.getLineAndCharacterOfPosition(start);
      diagnostics.push({ path: file.path, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '), startLine: pos.line + 1, startColumn: pos.character + 1 });
    }
  }

  if (input.manifest) {
    for (const entry of input.manifest) {
      if (entry.classification === 'source' || entry.language !== null || (entry.classification !== 'binary' && entry.classification !== 'vendor')) {
        const id = nodeId(input.snapshotId, 'file', entry.path, version);
        if (!nodes.has(id)) {
          addNode(nodes, input.snapshotId, 'file', entry.path, version, {
            path: entry.path,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
            attributes: {
              ...(entry.language ? { language: entry.language } : {}),
              classification: entry.classification,
              size: entry.size,
            },
          });
          addEdge(edges, input.snapshotId, 'CONTAINS', snapshotNode, id, 'observed', version, {
            path: entry.path,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
          });
        }
      }
    }
  }

  const fileExportedNames = new Map<string, Map<string, string>>();
  const fileReexportsMap = new Map<string, ReexportEntry[]>();

  for (const parsed of parsedSources) {
    const { exportedNames, reexports } = collectExportedBindings(parsed, declarations, exportedBindings);
    fileExportedNames.set(parsed.file.path, exportedNames);
    fileReexportsMap.set(parsed.file.path, reexports);
  }

  for (const parsed of parsedSources) {
    collectImportedBindings(parsed, parsedSources, exportedBindings, importedBindings, input.snapshotId, version, nodes, edges, allFilesSet);
  }

  // Multi-pass fixed-point resolution for barrels, re-exports, and aliases
  for (let pass = 0; pass < 10; pass++) {
    let updated = false;

    // 1. Resolve local exports
    for (const [filePath, exportsMap] of fileExportedNames) {
      for (const [exportName, localName] of exportsMap) {
        if (!exportedBindings.has(`${filePath}:${exportName}`)) {
          const id = declarations.get(`${filePath}:${localName}`) ?? importedBindings.get(`${filePath}:${localName}`);
          if (id) {
            exportedBindings.set(`${filePath}:${exportName}`, id);
            updated = true;
          }
        }
        for (const [key, id] of declarations) {
          if (key.startsWith(`${filePath}:${localName}.`)) {
            const prop = key.slice(`${filePath}:${localName}.`.length);
            const exportPropKey = `${filePath}:${exportName}.${prop}`;
            if (!exportedBindings.has(exportPropKey)) {
              exportedBindings.set(exportPropKey, id);
              updated = true;
            }
          }
        }
        for (const [key, id] of importedBindings) {
          if (key.startsWith(`${filePath}:${localName}.`)) {
            const prop = key.slice(`${filePath}:${localName}.`.length);
            const exportPropKey = `${filePath}:${exportName}.${prop}`;
            if (!exportedBindings.has(exportPropKey)) {
              exportedBindings.set(exportPropKey, id);
              updated = true;
            }
          }
        }
      }
    }

    // 2. Resolve cross-file re-exports (star, namespace, named)
    for (const [filePath, reexports] of fileReexportsMap) {
      for (const reexp of reexports) {
        const target = resolveTsModule(filePath, reexp.moduleSpecifier, allFilesSet);
        if (!target) continue;

        if (reexp.isStar) {
          for (const [key, id] of exportedBindings) {
            if (key.startsWith(`${target}:`)) {
              const exp = key.slice(target.length + 1);
              if (exp !== 'default') {
                const myKey = `${filePath}:${exp}`;
                if (!exportedBindings.has(myKey)) {
                  exportedBindings.set(myKey, id);
                  updated = true;
                }
              }
            }
          }
        } else if (reexp.namespace) {
          for (const [key, id] of exportedBindings) {
            if (key.startsWith(`${target}:`)) {
              const exp = key.slice(target.length + 1);
              const myKey = `${filePath}:${reexp.namespace}.${exp}`;
              if (!exportedBindings.has(myKey)) {
                exportedBindings.set(myKey, id);
                updated = true;
              }
            }
          }
        } else if (reexp.elements) {
          for (const el of reexp.elements) {
            const targetId = exportedBindings.get(`${target}:${el.localName}`) ?? declarations.get(`${target}:${el.localName}`);
            if (targetId && !exportedBindings.has(`${filePath}:${el.exportName}`)) {
              exportedBindings.set(`${filePath}:${el.exportName}`, targetId);
              updated = true;
            }
            for (const [key, id] of exportedBindings) {
              if (key.startsWith(`${target}:${el.localName}.`)) {
                const prop = key.slice(`${target}:${el.localName}.`.length);
                const myKey = `${filePath}:${el.exportName}.${prop}`;
                if (!exportedBindings.has(myKey)) {
                  exportedBindings.set(myKey, id);
                  updated = true;
                }
              }
            }
          }
        }
      }
    }

    // 3. Re-collect imported bindings with updated exports
    for (const parsed of parsedSources) {
      collectImportedBindings(parsed, parsedSources, exportedBindings, importedBindings, input.snapshotId, version, nodes, edges, allFilesSet);
    }

    if (!updated) break;
  }

  // Symbol declaration and call resolution pass
  for (const { file, source, fileId } of parsedSources) {
    let currentClassName: string | undefined;

    const visit = (node: ts.Node, parentSymbol?: string) => {
      let current = parentSymbol;

      if (ts.isClassDeclaration(node)) {
        const name = symbolName(node);
        if (name) {
          currentClassName = name;
          const key = `${file.path}:${node.pos}:${name}`;
          const ev = evidence(file.path, source, node, name);
          const id = addNode(nodes, input.snapshotId, 'symbol', key, version, ev);
          addEdge(edges, input.snapshotId, 'DECLARES', fileId, id, 'observed', version, ev);
          current = id;

          for (const heritage of node.heritageClauses ?? []) {
            for (const type of heritage.types) {
              const target = type.expression.getText(source);
              const targetId = declarations.get(`${file.path}:${target}`) ?? importedBindings.get(`${file.path}:${target}`);
              const resolvedTargetId = targetId ?? addNode(nodes, input.snapshotId, 'symbol', `unresolved:${target}`, version, evidence(file.path, source, type, target, 'target declaration is not available'));
              addEdge(
                edges,
                input.snapshotId,
                heritage.token === ts.SyntaxKind.ExtendsKeyword ? 'EXTENDS' : 'IMPLEMENTS',
                id,
                resolvedTargetId,
                targetId ? 'resolved' : 'unresolved',
                version,
                evidence(file.path, source, type, target, targetId ? undefined : 'target declaration is not available')
              );
            }
          }
        }
      } else if (ts.isMethodDeclaration(node) && currentClassName) {
        const mName = symbolName(node);
        if (mName) {
          const key = `${file.path}:${node.pos}:${currentClassName}.${mName}`;
          const ev = evidence(file.path, source, node, `${currentClassName}.${mName}`);
          const id = addNode(nodes, input.snapshotId, 'symbol', key, version, ev);
          const ownerId = parentSymbol ?? fileId;
          addEdge(edges, input.snapshotId, 'DECLARES', ownerId, id, 'observed', version, ev);
          current = id;
        }
      } else if (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isConstructorDeclaration(node)) {
        const name = symbolName(node) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
        if (name) {
          const key = `${file.path}:${node.pos}:${name}`;
          const ev = evidence(file.path, source, node, name);
          const id = addNode(nodes, input.snapshotId, 'symbol', key, version, ev);
          addEdge(edges, input.snapshotId, 'DECLARES', fileId, id, 'observed', version, ev);
          current = id;
        }
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer))) {
        const name = node.name.text;
        const ev = evidence(file.path, source, node, name);
        const id = addNode(nodes, input.snapshotId, 'symbol', `${file.path}:${node.pos}:${name}`, version, ev);
        addEdge(edges, input.snapshotId, 'DECLARES', fileId, id, 'observed', version, ev);
        current = id;
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.name)) {
          const propName = node.left.name.text;
          const expr = node.left.expression;
          const isExports =
            (ts.isIdentifier(expr) && expr.text === 'exports') ||
            (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'module' && expr.name.text === 'exports');
          if (isExports) {
            const ev = evidence(file.path, source, node, propName);
            const id = addNode(nodes, input.snapshotId, 'symbol', `${file.path}:${node.pos}:${propName}`, version, ev);
            addEdge(edges, input.snapshotId, 'DECLARES', fileId, id, 'observed', version, ev);
            current = id;
          }
        }
      }

      // IMPORTS edges for import declarations
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveTsModule(file.path, node.moduleSpecifier.text, allFilesSet);
        const targetId = target ? addNode(nodes, input.snapshotId, 'file', target, version) : addNode(nodes, input.snapshotId, 'module', `unresolved:${node.moduleSpecifier.text}`, version);
        addEdge(edges, input.snapshotId, 'IMPORTS', fileId, targetId, target ? 'resolved' : 'unresolved', version, evidence(file.path, source, node.moduleSpecifier, node.moduleSpecifier.text, target ? undefined : 'relative module was not found'));
      }

      // IMPORTS edges for CommonJS require
      const requireArgument = ts.isCallExpression(node) && node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && requireArgument && ts.isStringLiteral(requireArgument)) {
        const specifier = requireArgument.text;
        const target = resolveTsModule(file.path, specifier, allFilesSet);
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

      // CALLS edges with precise scope & ambiguity/unresolved distinction
      if (ts.isCallExpression(node) && current) {
        if (ts.isIdentifier(node.expression)) {
          const targetName = node.expression.text;
          if (targetName === 'require') {
            ts.forEachChild(node, (child) => visit(child, current));
            return;
          }
          const targetId = declarations.get(`${file.path}:${targetName}`) ?? importedBindings.get(`${file.path}:${targetName}`);
          const callTargetId = targetId ?? addNode(nodes, input.snapshotId, 'symbol', `unresolved-call:${file.path}:${node.pos}`, version, evidence(file.path, source, node, targetName, 'call target is not statically identifiable'));
          addEdge(edges, input.snapshotId, 'CALLS', current, callTargetId, targetId ? 'resolved' : 'unresolved', version, evidence(file.path, source, node, targetName, targetId ? undefined : 'call target is not statically identifiable'));
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && ts.isIdentifier(node.expression.name)) {
          const receiver = node.expression.expression.text;
          const member = node.expression.name.text;

          let targetId = importedBindings.get(`${file.path}:${receiver}.${member}`);

          // Class instance call (e.g. const s = new Service(); s.doWork())
          if (!targetId && variableClassTypes.has(`${file.path}:${receiver}`)) {
            const className = variableClassTypes.get(`${file.path}:${receiver}`)!;
            targetId = declarations.get(`${file.path}:${className}.${member}`) ?? importedBindings.get(`${file.path}:${className}.${member}`);
          }

          // Static method call (e.g. Service.doWork())
          if (!targetId) {
            targetId = declarations.get(`${file.path}:${receiver}.${member}`) ?? importedBindings.get(`${file.path}:${receiver}.${member}`);
          }

          // this.method() inside class method
          if (!targetId && receiver === 'this' && currentClassName) {
            targetId = declarations.get(`${file.path}:${currentClassName}.${member}`) ?? importedBindings.get(`${file.path}:${currentClassName}.${member}`);
          }

          if (targetId) {
            addEdge(edges, input.snapshotId, 'CALLS', current, targetId, 'resolved', version, evidence(file.path, source, node, member));
          } else {
            const isImportedModule = nodes.has(nodeId(input.snapshotId, 'module', `unresolved:${receiver}`, version));
            if (isImportedModule) {
              const reason = `call on external or unresolved module "${receiver}"`;
              const callTargetId = addNode(nodes, input.snapshotId, 'symbol', `unresolved-call:${file.path}:${node.pos}`, version, evidence(file.path, source, node, member, reason));
              addEdge(edges, input.snapshotId, 'CALLS', current, callTargetId, 'unresolved', version, evidence(file.path, source, node, member, reason));
            }
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, current));
    };

    visit(source);
  }

  // Phase 5: Data-Flow Intelligence Pass (Intra-procedural and cross-file value propagation)
  const functionSignatures = new Map<string, FunctionDataFlowSignature>();
  analyzeTsDataFlow(parsedSources, {
    snapshotId: input.snapshotId,
    version,
    nodes,
    edges,
    declarations,
    importedBindings,
    variableClassTypes,
    functionSignatures,
  });

  // Framework Intelligence Pass: Express & Fastify
  extractExpressFramework(input.snapshotId, version, parsedSources, nodes, edges, declarations, importedBindings, allFilesSet);
  extractFastifyFramework(input.snapshotId, version, parsedSources, nodes, edges, declarations, importedBindings, allFilesSet);

  const pythonAdapter = new PythonLanguageAdapter();
  if (input.files.some((f) => pythonAdapter.canHandle(f))) {
    const pyResult = await pythonAdapter.analyze({
      snapshotId: input.snapshotId,
      files: input.files,
      manifest: input.manifest,
      analyzerVersion: version,
    });
    for (const node of pyResult.nodes) nodes.set(node.id, node);
    for (const edge of pyResult.edges) edges.set(edge.id, edge);
    diagnostics.push(...pyResult.diagnostics);
  }

  const goAdapter = new GoLanguageAdapter();
  if (input.files.some((f) => goAdapter.canHandle(f))) {
    const goResult = await goAdapter.analyze({
      snapshotId: input.snapshotId,
      files: input.files,
      manifest: input.manifest,
      analyzerVersion: version,
    });
    for (const node of goResult.nodes) nodes.set(node.id, node);
    for (const edge of goResult.edges) edges.set(edge.id, edge);
    diagnostics.push(...goResult.diagnostics);
  }

  const rustAdapter = new RustLanguageAdapter();
  if (input.files.some((f) => rustAdapter.canHandle(f))) {
    const rustResult = await rustAdapter.analyze({
      snapshotId: input.snapshotId,
      files: input.files,
      manifest: input.manifest,
      analyzerVersion: version,
    });
    for (const node of rustResult.nodes) nodes.set(node.id, node);
    for (const edge of rustResult.edges) edges.set(edge.id, edge);
    diagnostics.push(...rustResult.diagnostics);
  }

  return {
    schemaVersion: graphSchemaVersion,
    analyzerVersion: version,
    snapshotId: input.snapshotId,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: diagnostics.sort((a, b) => `${a.path}:${a.startLine ?? 0}`.localeCompare(`${b.path}:${b.startLine ?? 0}`)),
  };
}


function collectExportedBindings(
  parsed: { file: SourceFile; source: ts.SourceFile },
  declarations: Map<string, string>,
  exportedBindings: Map<string, string>
): { exportedNames: Map<string, string>; reexports: ReexportEntry[] } {
  const exportedNames = new Map<string, string>();
  const reexports: ReexportEntry[] = [];

  const visit = (node: ts.Node) => {
    const isSupportedDecl = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableStatement(node);
    if (isSupportedDecl && hasExportModifier(node)) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exportedNames.set(declaration.name.text, declaration.name.text);
        }
      } else {
        const name = symbolName(node);
        if (name) {
          exportedNames.set(name, name);
          if ((ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) !== 0) {
            exportedNames.set('default', name);
          }
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (!node.exportClause) {
          // export * from './foo'
          reexports.push({ filePath: parsed.file.path, moduleSpecifier: specifier, isStar: true });
        } else if (ts.isNamespaceExport(node.exportClause)) {
          // export * as ns from './foo'
          reexports.push({ filePath: parsed.file.path, moduleSpecifier: specifier, namespace: node.exportClause.name.text });
        } else if (ts.isNamedExports(node.exportClause)) {
          // export { a, b as c } from './foo'
          reexports.push({
            filePath: parsed.file.path,
            moduleSpecifier: specifier,
            elements: node.exportClause.elements.map((el) => ({
              exportName: el.name.text,
              localName: el.propertyName?.text ?? el.name.text,
            })),
          });
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exportedNames.set(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) {
        exportedNames.set('default', node.expression.text);
      } else if (ts.isObjectLiteralExpression(node.expression)) {
        for (const prop of node.expression.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) exportedNames.set(prop.name.text, prop.name.text);
          else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            const val = ts.isIdentifier(prop.initializer) ? prop.initializer.text : prop.name.text;
            exportedNames.set(prop.name.text, val);
          }
        }
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left)) {
        const isModuleExports = ts.isIdentifier(left.expression) && left.expression.text === 'module' && left.name.text === 'exports';
        const isExportsProperty = ts.isIdentifier(left.expression) && left.expression.text === 'exports';
        const isModuleExportsProperty = ts.isPropertyAccessExpression(left.expression) && ts.isIdentifier(left.expression.expression) && left.expression.expression.text === 'module' && left.expression.name.text === 'exports';
        if (isModuleExports) {
          if (ts.isIdentifier(node.right)) exportedNames.set('default', node.right.text);
          else if (ts.isObjectLiteralExpression(node.right)) {
            for (const prop of node.right.properties) {
              if (ts.isShorthandPropertyAssignment(prop)) exportedNames.set(prop.name.text, prop.name.text);
              else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                const val = ts.isIdentifier(prop.initializer) ? prop.initializer.text : prop.name.text;
                exportedNames.set(prop.name.text, val);
              }
            }
          }
        } else if (isExportsProperty || isModuleExportsProperty) {
          if (ts.isIdentifier(node.right)) exportedNames.set(left.name.text, node.right.text);
          else exportedNames.set(left.name.text, left.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.source);

  for (const [exportName, localName] of exportedNames) {
    const id = declarations.get(`${parsed.file.path}:${localName}`) ?? declarations.get(`${parsed.file.path}:${exportName}`);
    if (id) exportedBindings.set(`${parsed.file.path}:${exportName}`, id);
  }
  return { exportedNames, reexports };
}

function collectImportedBindings(
  parsed: { file: SourceFile; source: ts.SourceFile; fileId: string },
  sources: readonly { file: SourceFile; source: ts.SourceFile; fileId: string }[],
  exportedBindings: Map<string, string>,
  importedBindings: Map<string, string>,
  snapshotId: string,
  version: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  allFilesSet: ReadonlySet<string>
) {
  for (const statement of parsed.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveTsModule(parsed.file.path, statement.moduleSpecifier.text, allFilesSet);
      if (!target) {
        continue;
      }
      if (statement.importClause) {
        if (statement.importClause.name) bindImported(parsed, target, 'default', statement.importClause.name.text, exportedBindings, importedBindings);
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) bindImported(parsed, target, '*', bindings.name.text, exportedBindings, importedBindings);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            bindImported(parsed, target, element.propertyName?.text ?? element.name.text, element.name.text, exportedBindings, importedBindings);
          }
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === 'require' &&
          declaration.initializer.arguments[0] &&
          ts.isStringLiteral(declaration.initializer.arguments[0])
        ) {
          const specifier = declaration.initializer.arguments[0].text;
          const target = resolveTsModule(parsed.file.path, specifier, allFilesSet);
          if (!target) continue;
          if (ts.isIdentifier(declaration.name)) {
            bindImported(parsed, target, 'default', declaration.name.text, exportedBindings, importedBindings);
            bindImported(parsed, target, '*', declaration.name.text, exportedBindings, importedBindings);
          } else if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (ts.isIdentifier(element.name)) {
                const propertyName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
                bindImported(parsed, target, propertyName, element.name.text, exportedBindings, importedBindings);
              }
            }
          }
        }
      }
    }
  }
}

function bindImported(
  parsed: { file: SourceFile },
  target: string,
  exportedName: string,
  localName: string,
  exportedBindings: Map<string, string>,
  importedBindings: Map<string, string>
) {
  const direct = exportedBindings.get(`${target}:${exportedName}`);
  if (direct) importedBindings.set(`${parsed.file.path}:${localName}`, direct);
  if (exportedName === '*' || exportedName === 'default') {
    for (const [key, id] of exportedBindings) {
      if (key.startsWith(`${target}:`)) {
        const prop = key.slice(target.length + 1);
        if (prop !== 'default') {
          importedBindings.set(`${parsed.file.path}:${localName}.${prop}`, id);
        }
      }
    }
  } else {
    for (const [key, id] of exportedBindings) {
      if (key.startsWith(`${target}:${exportedName}.`)) {
        const prop = key.slice(`${target}:${exportedName}.`.length);
        importedBindings.set(`${parsed.file.path}:${localName}.${prop}`, id);
      }
    }
  }
}



export function resolveRelative(from: string, specifier: string, paths: readonly string[]): string | undefined {
  return resolveTsModule(from, specifier, new Set(paths));
}
