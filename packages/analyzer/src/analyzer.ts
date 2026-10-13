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

export function analyzeRepository(input: AnalyzeInput): AnalysisResult {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const diagnostics: Diagnostic[] = [];
  const version = input.analyzerVersion ?? analyzerVersion;
  const files = input.files.filter((file) => supported.has(file.path.slice(file.path.lastIndexOf('.')).toLowerCase())).sort((a, b) => a.path.localeCompare(b.path));
  const snapshotNode = addNode(nodes, input.snapshotId, 'snapshot', input.snapshotId, version);
  const declarations = new Map<string, string>();
  const importedBindings = new Map<string, string>();
  const exportedBindings = new Map<string, string>();
  const parsedSources: Array<{ file: SourceFile; source: ts.SourceFile; fileId: string }> = [];
  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, file.path.endsWith('x') ? ts.ScriptKind.TSX : file.path.endsWith('.ts') ? ts.ScriptKind.TS : file.path.endsWith('jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS);
    const fileId = addNode(nodes, input.snapshotId, 'file', file.path, version, { path: file.path, startLine: 1, startColumn: 1, endLine: source.getLineAndCharacterOfPosition(source.end).line + 1, endColumn: source.getLineAndCharacterOfPosition(source.end).character + 1 });
    parsedSources.push({ file, source, fileId });
    addEdge(edges, input.snapshotId, 'CONTAINS', snapshotNode, fileId, 'observed', version, { path: file.path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 });
    const collectDeclarations = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
        const name = symbolName(node) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
        if (name) declarations.set(`${file.path}:${name}`, nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${name}`, version));
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer))) {
        declarations.set(`${file.path}:${node.name.text}`, nodeId(input.snapshotId, 'symbol', `${file.path}:${node.pos}:${node.name.text}`, version));
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

  const fileExportedNames = new Map<string, Map<string, string>>();
  for (const parsed of parsedSources) fileExportedNames.set(parsed.file.path, collectExportedBindings(parsed, declarations, exportedBindings));
  for (const parsed of parsedSources) collectImportedBindings(parsed, parsedSources, exportedBindings, importedBindings, input.snapshotId, version, nodes, edges);
  for (let pass = 0; pass < 3; pass++) {
    let updated = false;
    for (const [filePath, exportsMap] of fileExportedNames) {
      for (const [exportName, localName] of exportsMap) {
        if (!exportedBindings.has(`${filePath}:${exportName}`)) {
          const id = declarations.get(`${filePath}:${localName}`) ?? importedBindings.get(`${filePath}:${localName}`);
          if (id) {
            exportedBindings.set(`${filePath}:${exportName}`, id);
            updated = true;
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
    if (!updated) break;
    for (const parsed of parsedSources) {
      collectImportedBindings(parsed, parsedSources, exportedBindings, importedBindings, input.snapshotId, version, nodes, edges);
    }
  }

  for (const { file, source, fileId } of parsedSources) {
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
          if (ts.isClassDeclaration(node)) {
            for (const heritage of node.heritageClauses ?? []) for (const type of heritage.types) {
              const target = type.expression.getText(source);
              const targetId = declarations.get(`${file.path}:${target}`) ?? importedBindings.get(`${file.path}:${target}`);
              const resolvedTargetId = targetId ?? addNode(nodes, input.snapshotId, 'symbol', `unresolved:${target}`, version, evidence(file.path, source, type, target, 'target declaration is not available'));
              addEdge(edges, input.snapshotId, heritage.token === ts.SyntaxKind.ExtendsKeyword ? 'EXTENDS' : 'IMPLEMENTS', id, resolvedTargetId, targetId ? 'resolved' : 'unresolved', version, evidence(file.path, source, type, target, targetId ? undefined : 'target declaration is not available'));
            }
          }
        }
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer))) {
        const name = node.name.text;
        const ev = evidence(file.path, source, node, name);
        const id = addNode(nodes, input.snapshotId, 'symbol', `${file.path}:${node.pos}:${name}`, version, ev);
        addEdge(edges, input.snapshotId, 'DECLARES', fileId, id, 'observed', version, ev);
        current = id;
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
        if (ts.isIdentifier(node.expression)) {
          const targetName = node.expression.text;
          const targetId = declarations.get(`${file.path}:${targetName}`) ?? importedBindings.get(`${file.path}:${targetName}`);
          const callTargetId = targetId ?? addNode(nodes, input.snapshotId, 'symbol', `unresolved-call:${file.path}:${node.pos}`, version, evidence(file.path, source, node, targetName, 'call target is not statically identifiable'));
          addEdge(edges, input.snapshotId, 'CALLS', current, callTargetId, targetId ? 'resolved' : 'unresolved', version, evidence(file.path, source, node, targetName, targetId ? undefined : 'call target is not statically identifiable'));
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && ts.isIdentifier(node.expression.name)) {
          const receiver = node.expression.expression.text;
          const member = node.expression.name.text;
          const targetId = importedBindings.get(`${file.path}:${receiver}.${member}`);
          if (targetId) {
            addEdge(edges, input.snapshotId, 'CALLS', current, targetId, 'resolved', version, evidence(file.path, source, node, member));
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, current));
    };
    visit(source);
  }

  const allFilePaths = files.map((f) => f.path);
  const fileMountPrefixes = new Map<string, string>();
  for (const parsed of parsedSources) {
    const collectMounts = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'use') {
        const rawPrefix = node.arguments[0] && routePath(node.arguments[0], parsed.source);
        const routerArg = rawPrefix !== undefined ? node.arguments[1] : node.arguments[0];
        const mount = rawPrefix !== undefined ? rawPrefix : '';
        if (routerArg && ts.isIdentifier(routerArg)) {
          const importDecl = parsed.source.statements.find((stmt) => (ts.isImportDeclaration(stmt) && (stmt.importClause?.name?.text === routerArg.text || (stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings) && stmt.importClause.namedBindings.elements.some((el) => el.name.text === routerArg.text)))) || (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === routerArg.text && d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === 'require')));
          const specifier = importDecl && ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier) ? importDecl.moduleSpecifier.text : (importDecl && ts.isVariableStatement(importDecl) ? importDecl.declarationList.declarations[0]?.initializer && ts.isCallExpression(importDecl.declarationList.declarations[0].initializer) && importDecl.declarationList.declarations[0].initializer.arguments[0] && ts.isStringLiteral(importDecl.declarationList.declarations[0].initializer.arguments[0]) ? importDecl.declarationList.declarations[0].initializer.arguments[0].text : undefined : undefined);
          if (specifier) {
            const targetPath = resolveRelative(parsed.file.path, specifier, allFilePaths);
            if (targetPath) {
              fileMountPrefixes.set(targetPath, joinRoutePath(fileMountPrefixes.get(parsed.file.path) ?? '', mount));
            }
          }
        }
      }
      ts.forEachChild(node, collectMounts);
    };
    collectMounts(parsed.source);
  }

  for (const parsed of parsedSources) extractExpressFacts(input.snapshotId, version, parsed, nodes, edges, declarations, importedBindings, fileMountPrefixes, allFilePaths);
  return { schemaVersion: graphSchemaVersion, analyzerVersion: version, snapshotId: input.snapshotId, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)), diagnostics: diagnostics.sort((a, b) => `${a.path}:${a.startLine ?? 0}`.localeCompare(`${b.path}:${b.startLine ?? 0}`)) };
}

const expressMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);
const routePath = (node: ts.Expression, source: ts.SourceFile): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const declaration = source.statements.find((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === node.text));
    const variable = declaration && ts.isVariableStatement(declaration) ? declaration.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === node.text) : undefined;
    return variable?.initializer && (ts.isStringLiteral(variable.initializer) || ts.isNoSubstitutionTemplateLiteral(variable.initializer)) ? variable.initializer.text : undefined;
  }
  return undefined;
};

function collectExportedBindings(parsed: { file: SourceFile; source: ts.SourceFile }, declarations: Map<string, string>, exportedBindings: Map<string, string>) {
  const exportedNames = new Map<string, string>();
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
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) exportedNames.set(element.name.text, element.propertyName?.text ?? element.name.text);
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
  return exportedNames;
}

function collectImportedBindings(parsed: { file: SourceFile; source: ts.SourceFile; fileId: string }, sources: readonly { file: SourceFile; source: ts.SourceFile; fileId: string }[], exportedBindings: Map<string, string>, importedBindings: Map<string, string>, snapshotId: string, version: string, nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>) {
  const paths = sources.map((item) => item.file.path);
  for (const statement of parsed.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveRelative(parsed.file.path, statement.moduleSpecifier.text, paths);
      if (!target || !statement.importClause) continue;
      const targetId = addNode(nodes, snapshotId, 'file', target, version);
      if (statement.importClause.name) bindImported(parsed, target, 'default', statement.importClause.name.text, exportedBindings, importedBindings);
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) bindImported(parsed, target, '*', bindings.name.text, exportedBindings, importedBindings);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) bindImported(parsed, target, element.propertyName?.text ?? element.name.text, element.name.text, exportedBindings, importedBindings);
      addEdge(edges, snapshotId, 'IMPORTS', parsed.fileId, targetId, 'resolved', version, evidence(parsed.file.path, parsed.source, statement.moduleSpecifier, statement.moduleSpecifier.text));
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === 'require' && declaration.initializer.arguments[0] && ts.isStringLiteral(declaration.initializer.arguments[0])) {
          const specifier = declaration.initializer.arguments[0].text;
          const target = resolveRelative(parsed.file.path, specifier, paths);
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

function bindImported(parsed: { file: SourceFile }, target: string, exportedName: string, localName: string, exportedBindings: Map<string, string>, importedBindings: Map<string, string>) {
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

function extractExpressFacts(snapshotId: string, version: string, parsed: { file: SourceFile; source: ts.SourceFile; fileId: string }, nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>, declarations: Map<string, string>, importedBindings: Map<string, string>, fileMountPrefixes: Map<string, string>, allFiles: readonly string[]) {
  const receivers = new Set<string>();
  const prefixes = new Map<string, string>();
  const basePrefix = fileMountPrefixes.get(parsed.file.path) ?? '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const expression = node.initializer.expression;
      const isExpressFactory = ts.isIdentifier(expression) && (expression.text === 'express' || expression.text === 'Router');
      const isRouterFactory = ts.isPropertyAccessExpression(expression) && expression.name.text === 'Router';
      if (isExpressFactory || isRouterFactory) {
        receivers.add(node.name.text);
        if (basePrefix) prefixes.set(node.name.text, basePrefix);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.source);
  const importsExpress = parsed.source.statements.some((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'express')
    || parsed.source.statements.some((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => item.initializer && ts.isCallExpression(item.initializer) && ts.isIdentifier(item.initializer.expression) && item.initializer.expression.text === 'require' && item.initializer.arguments[0] && ts.isStringLiteral(item.initializer.arguments[0]) && item.initializer.arguments[0].text === 'express'));
  if (!importsExpress && receivers.size === 0) return;
  const collectMounts = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.name.text === 'use' && receivers.has(node.expression.expression.text) && node.arguments.length > 1 && node.arguments[0] && node.arguments[1] && ts.isIdentifier(node.arguments[1])) {
      const mount = routePath(node.arguments[0], parsed.source);
      if (mount !== undefined) prefixes.set(node.arguments[1].text, joinRoutePath(prefixes.get(node.expression.expression.text) ?? basePrefix, mount));
    }
    ts.forEachChild(node, collectMounts);
  };
  collectMounts(parsed.source);
  const routeVisit = (node: ts.Node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      ts.forEachChild(node, routeVisit);
      return;
    }
    const chained = findRouteChain(node.expression.expression);
    const receiver = ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : chained?.receiver;
    const methodName = node.expression.name.text;
    if (!receiver || !receivers.has(receiver) || (!expressMethods.has(methodName) && !chained)) {
      ts.forEachChild(node, routeVisit);
      return;
    }
    const method = node.expression.name.text.toUpperCase();
    const first = chained?.route.arguments[0] ?? node.arguments[0];
    const rawPath = first && routePath(first, parsed.source);
    const currentPrefix = (receiver ? prefixes.get(receiver) : undefined) ?? basePrefix;
    const path = rawPath === undefined ? undefined : joinRoutePath(currentPrefix, rawPath);
    const hasPath = Boolean(path);
    const routeKey = `${parsed.file.path}:${node.pos}:${method}:${path ?? '<unresolved>'}`;
    const routeEvidence = sourceEvidenceWithAttributes(parsed.file.path, parsed.source, node, `${method} ${path ?? '<unresolved>'}`, {
      method,
      path: path ?? '<unresolved>',
      framework: 'express',
      kind: method === 'USE' ? 'middleware' : 'endpoint',
      ...(hasPath ? {} : { reason: 'route path is not statically resolvable' }),
    });
    const routeId = addNode(nodes, snapshotId, 'route', routeKey, version, routeEvidence);
    addEdge(edges, snapshotId, 'CONTAINS', parsed.fileId, routeId, 'observed', version, routeEvidence);
    const handlerStart = hasPath ? 1 : 0;
    const rawHandlers = node.arguments.slice(handlerStart);
    const handlerArgs = flattenHandlerArguments(rawHandlers);
    handlerArgs.forEach((argument, index) => {
      const handler = resolveHandler(snapshotId, version, parsed, argument, nodes, declarations, importedBindings);
      const isMiddleware = method === 'USE' || index < handlerArgs.length - 1;
      addEdge(edges, snapshotId, isMiddleware ? 'MIDDLEWARE' : 'ROUTE_HANDLER', routeId, handler.id, handler.resolution, version, sourceEvidenceWithAttributes(parsed.file.path, parsed.source, argument, undefined, { order: index, role: isMiddleware ? 'middleware' : 'handler' }));
    });
    ts.forEachChild(node, routeVisit);
  };
  routeVisit(parsed.source);
}

function flattenHandlerArguments(args: readonly ts.Expression[]): ts.Expression[] {
  const flattened: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isArrayLiteralExpression(arg)) {
      flattened.push(...flattenHandlerArguments(arg.elements.filter((el): el is ts.Expression => ts.isExpression(el))));
    } else {
      flattened.push(arg);
    }
  }
  return flattened;
}

function findRouteChain(expression: ts.Expression): { route: ts.CallExpression; receiver: string } | undefined {
  let current: ts.Expression = expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const property = current.expression;
    if (property.name.text === 'route' && ts.isIdentifier(property.expression)) return { route: current, receiver: property.expression.text };
    current = property.expression;
  }
  return undefined;
}

function unwrapHandler(argument: ts.Expression): ts.Expression {
  let inner = argument;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isCallExpression(inner) && inner.arguments.length >= 1 && inner.arguments[0]) {
    if (ts.isIdentifier(inner.expression) && /^(catchAsync|asyncHandler|wrap|asyncWrap|rescue)$/i.test(inner.expression.text)) {
      return unwrapHandler(inner.arguments[0]);
    }
  }
  return inner;
}

function resolveHandler(snapshotId: string, version: string, parsed: { file: SourceFile; source: ts.SourceFile }, argument: ts.Expression, nodes: Map<string, GraphNode>, declarations: Map<string, string>, importedBindings: Map<string, string>): { id: string; resolution: GraphEdge['resolution'] } {
  const unwrapped = unwrapHandler(argument);
  if (ts.isIdentifier(unwrapped)) {
    const declaration = declarations.get(`${parsed.file.path}:${unwrapped.text}`) ?? importedBindings.get(`${parsed.file.path}:${unwrapped.text}`);
    return declaration ? { id: declaration, resolution: 'resolved' } : { id: addNode(nodes, snapshotId, 'symbol', `unresolved-handler:${parsed.file.path}:${unwrapped.text}`, version, sourceEvidenceWithAttributes(parsed.file.path, parsed.source, argument, unwrapped.text, { reason: 'handler declaration is not statically available' })), resolution: 'unresolved' };
  }
  if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.name)) {
    const receiver = ts.isIdentifier(unwrapped.expression) ? unwrapped.expression.text : undefined;
    const declaration = (receiver ? importedBindings.get(`${parsed.file.path}:${receiver}.${unwrapped.name.text}`) : undefined)
      ?? declarations.get(`${parsed.file.path}:${unwrapped.name.text}`)
      ?? importedBindings.get(`${parsed.file.path}:${unwrapped.name.text}`);
    return declaration ? { id: declaration, resolution: 'resolved' } : { id: addNode(nodes, snapshotId, 'symbol', `unresolved-handler:${parsed.file.path}:${unwrapped.getText(parsed.source)}`, version, sourceEvidenceWithAttributes(parsed.file.path, parsed.source, argument, unwrapped.getText(parsed.source), { reason: 'handler member is not statically available' })), resolution: 'unresolved' };
  }

  if (ts.isCallExpression(unwrapped)) {
    if (ts.isIdentifier(unwrapped.expression)) {
      const middlewareFn = unwrapped.expression.text;
      const declaration = declarations.get(`${parsed.file.path}:${middlewareFn}`) ?? importedBindings.get(`${parsed.file.path}:${middlewareFn}`);
      return declaration ? { id: declaration, resolution: 'resolved' } : { id: addNode(nodes, snapshotId, 'symbol', `unresolved-middleware:${parsed.file.path}:${middlewareFn}`, version, sourceEvidenceWithAttributes(parsed.file.path, parsed.source, argument, middlewareFn, { reason: 'middleware factory declaration is not statically available' })), resolution: 'unresolved' };
    }
    if (ts.isPropertyAccessExpression(unwrapped.expression) && ts.isIdentifier(unwrapped.expression.name)) {
      const receiver = ts.isIdentifier(unwrapped.expression.expression) ? unwrapped.expression.expression.text : undefined;
      const declaration = (receiver ? importedBindings.get(`${parsed.file.path}:${receiver}.${unwrapped.expression.name.text}`) : undefined)
        ?? declarations.get(`${parsed.file.path}:${unwrapped.expression.name.text}`)
        ?? importedBindings.get(`${parsed.file.path}:${unwrapped.expression.name.text}`);
      return declaration ? { id: declaration, resolution: 'resolved' } : { id: addNode(nodes, snapshotId, 'symbol', `unresolved-middleware:${parsed.file.path}:${unwrapped.expression.getText(parsed.source)}`, version, sourceEvidenceWithAttributes(parsed.file.path, parsed.source, argument, unwrapped.expression.getText(parsed.source), { reason: 'middleware factory member is not statically available' })), resolution: 'unresolved' };
    }
  }

  if (ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)) {
    const name = `inline-handler:${parsed.file.path}:${unwrapped.pos}`;
    return { id: addNode(nodes, snapshotId, 'symbol', name, version, evidence(parsed.file.path, parsed.source, argument, 'inline handler')), resolution: 'observed' };
  }
  return { id: addNode(nodes, snapshotId, 'symbol', `unresolved-handler:${parsed.file.path}:${argument.pos}`, version, sourceEvidenceWithAttributes(parsed.file.path, parsed.source, argument, undefined, { reason: 'handler is not statically identifiable' })), resolution: 'unresolved' };
}

function sourceEvidenceWithAttributes(path: string, source: ts.SourceFile, node: ts.Node, name: string | undefined, attributes: Record<string, string | number | boolean>): SourceEvidence {
  const result = evidence(path, source, node, name);
  return { ...result, attributes };
}

function joinRoutePath(prefix: string, path: string): string {
  const left = prefix.trim();
  const right = path.trim();
  if (!left || left === '/') return right || '/';
  if (!right || right === '/') return left || '/';
  return `/${[left, right].join('/').split('/').filter(Boolean).join('/')}`;
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
