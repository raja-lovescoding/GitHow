import ts from 'typescript';
import {
  type GraphEdge,
  type GraphNode,
  type SourceEvidence,
} from '../model.js';
import type { SourceFile } from '../analyzer.js';
import { resolveTsModule } from '../resolution.js';
import {
  connectRouteRelationship,
  createRouteNode,
  createUnresolvedSymbol,
  joinRoutePath,
} from './common.js';

const expressMethods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'all',
  'head',
  'options',
  'use',
]);

function getRoutePathString(node: ts.Expression, source: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isIdentifier(node)) {
    const declaration = source.statements.find(
      (stmt) =>
        ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.some(
          (item) => ts.isIdentifier(item.name) && item.name.text === node.text
        )
    );
    const variable =
      declaration && ts.isVariableStatement(declaration)
        ? declaration.declarationList.declarations.find(
            (item) => ts.isIdentifier(item.name) && item.name.text === node.text
          )
        : undefined;
    return variable?.initializer &&
      (ts.isStringLiteral(variable.initializer) || ts.isNoSubstitutionTemplateLiteral(variable.initializer))
      ? variable.initializer.text
      : undefined;
  }
  return undefined;
}

function unwrapHandler(argument: ts.Expression): ts.Expression {
  let inner = argument;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  if (ts.isCallExpression(inner) && inner.arguments.length >= 1 && inner.arguments[0]) {
    if (
      ts.isIdentifier(inner.expression) &&
      /^(catchAsync|asyncHandler|wrap|asyncWrap|rescue)$/i.test(inner.expression.text)
    ) {
      return unwrapHandler(inner.arguments[0]);
    }
  }
  return inner;
}

function flattenHandlerArguments(args: readonly ts.Expression[]): ts.Expression[] {
  const flattened: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isArrayLiteralExpression(arg)) {
      flattened.push(
        ...flattenHandlerArguments(arg.elements.filter((el): el is ts.Expression => ts.isExpression(el)))
      );
    } else {
      flattened.push(arg);
    }
  }
  return flattened;
}

function findRouteChain(
  expression: ts.Expression
): { route: ts.CallExpression; receiver: string } | undefined {
  let current: ts.Expression = expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const property = current.expression;
    if (property.name.text === 'route' && ts.isIdentifier(property.expression)) {
      return { route: current, receiver: property.expression.text };
    }
    current = property.expression;
  }
  return undefined;
}

function resolveHandler(
  snapshotId: string,
  version: string,
  parsed: { file: SourceFile; source: ts.SourceFile },
  argument: ts.Expression,
  nodes: Map<string, GraphNode>,
  declarations: Map<string, string>,
  importedBindings: Map<string, string>
): { id: string; resolution: GraphEdge['resolution'] } {
  const unwrapped = unwrapHandler(argument);
  const start = parsed.source.getLineAndCharacterOfPosition(argument.getStart(parsed.source));
  const end = parsed.source.getLineAndCharacterOfPosition(argument.end);

  const ev: SourceEvidence = {
    path: parsed.file.path,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };

  if (ts.isIdentifier(unwrapped)) {
    const declaration =
      declarations.get(`${parsed.file.path}:${unwrapped.text}`) ??
      importedBindings.get(`${parsed.file.path}:${unwrapped.text}`);
    if (declaration) {
      return { id: declaration, resolution: 'resolved' };
    }
    const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-handler:${parsed.file.path}:${unwrapped.text}`, {
      ...ev,
      name: unwrapped.text,
      attributes: { reason: 'handler declaration is not statically available' },
    });
    return { id, resolution: 'unresolved' };
  }

  if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.name)) {
    const receiver = ts.isIdentifier(unwrapped.expression) ? unwrapped.expression.text : undefined;
    const declaration =
      (receiver ? importedBindings.get(`${parsed.file.path}:${receiver}.${unwrapped.name.text}`) : undefined) ??
      declarations.get(`${parsed.file.path}:${unwrapped.name.text}`) ??
      importedBindings.get(`${parsed.file.path}:${unwrapped.name.text}`);
    if (declaration) {
      return { id: declaration, resolution: 'resolved' };
    }
    const text = unwrapped.getText(parsed.source);
    const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-handler:${parsed.file.path}:${text}`, {
      ...ev,
      name: text,
      attributes: { reason: 'handler member is not statically available' },
    });
    return { id, resolution: 'unresolved' };
  }

  if (ts.isCallExpression(unwrapped)) {
    if (ts.isIdentifier(unwrapped.expression)) {
      const middlewareFn = unwrapped.expression.text;
      const declaration =
        declarations.get(`${parsed.file.path}:${middlewareFn}`) ??
        importedBindings.get(`${parsed.file.path}:${middlewareFn}`);
      if (declaration) {
        return { id: declaration, resolution: 'resolved' };
      }
      const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-middleware:${parsed.file.path}:${middlewareFn}`, {
        ...ev,
        name: middlewareFn,
        attributes: { reason: 'middleware factory declaration is not statically available' },
      });
      return { id, resolution: 'unresolved' };
    }
    if (ts.isPropertyAccessExpression(unwrapped.expression) && ts.isIdentifier(unwrapped.expression.name)) {
      const receiver = ts.isIdentifier(unwrapped.expression.expression)
        ? unwrapped.expression.expression.text
        : undefined;
      const declaration =
        (receiver
          ? importedBindings.get(`${parsed.file.path}:${receiver}.${unwrapped.expression.name.text}`)
          : undefined) ??
        declarations.get(`${parsed.file.path}:${unwrapped.expression.name.text}`) ??
        importedBindings.get(`${parsed.file.path}:${unwrapped.expression.name.text}`);
      if (declaration) {
        return { id: declaration, resolution: 'resolved' };
      }
      const text = unwrapped.expression.getText(parsed.source);
      const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-middleware:${parsed.file.path}:${text}`, {
        ...ev,
        name: text,
        attributes: { reason: 'middleware factory member is not statically available' },
      });
      return { id, resolution: 'unresolved' };
    }
  }

  if (ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)) {
    const key = `inline-handler:${parsed.file.path}:${unwrapped.pos}`;
    const id = createUnresolvedSymbol(nodes, snapshotId, version, key, {
      ...ev,
      name: 'inline handler',
    });
    return { id, resolution: 'observed' };
  }

  const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-handler:${parsed.file.path}:${argument.pos}`, {
    ...ev,
    attributes: { reason: 'handler is not statically identifiable' },
  });
  return { id, resolution: 'unresolved' };
}

export function extractExpressFramework(
  snapshotId: string,
  version: string,
  parsedSources: readonly { file: SourceFile; source: ts.SourceFile; fileId: string }[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  declarations: Map<string, string>,
  importedBindings: Map<string, string>,
  allFilesSet: ReadonlySet<string>
) {
  // Step 1: Discover cross-file router mounts
  const fileMountPrefixes = new Map<string, string>();
  const routerMountEdges: Array<{ fromFile: string; toFile: string; mountPrefix: string; callNode: ts.CallExpression }> = [];

  for (const parsed of parsedSources) {
    const collectMounts = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'use'
      ) {
        const rawPrefix = node.arguments[0] && getRoutePathString(node.arguments[0], parsed.source);
        const routerArg = rawPrefix !== undefined ? node.arguments[1] : node.arguments[0];
        const mount = rawPrefix !== undefined ? rawPrefix : '';

        if (routerArg && ts.isIdentifier(routerArg)) {
          // Look up import declaration for this routerArg
          let specifier: string | undefined;
          for (const stmt of parsed.source.statements) {
            if (
              ts.isImportDeclaration(stmt) &&
              ts.isStringLiteral(stmt.moduleSpecifier) &&
              (stmt.importClause?.name?.text === routerArg.text ||
                (stmt.importClause?.namedBindings &&
                  ts.isNamedImports(stmt.importClause.namedBindings) &&
                  stmt.importClause.namedBindings.elements.some((el) => el.name.text === routerArg.text)))
            ) {
              specifier = stmt.moduleSpecifier.text;
              break;
            }
            if (ts.isVariableStatement(stmt)) {
              for (const d of stmt.declarationList.declarations) {
                if (
                  ts.isIdentifier(d.name) &&
                  d.name.text === routerArg.text &&
                  d.initializer &&
                  ts.isCallExpression(d.initializer) &&
                  ts.isIdentifier(d.initializer.expression) &&
                  d.initializer.expression.text === 'require' &&
                  d.initializer.arguments[0] &&
                  ts.isStringLiteral(d.initializer.arguments[0])
                ) {
                  specifier = d.initializer.arguments[0].text;
                  break;
                }
              }
            }
          }

          if (specifier) {
            const targetPath = resolveTsModule(parsed.file.path, specifier, allFilesSet);
            if (targetPath) {
              routerMountEdges.push({
                fromFile: parsed.file.path,
                toFile: targetPath,
                mountPrefix: mount,
                callNode: node,
              });
            }
          }
        }
      }
      ts.forEachChild(node, collectMounts);
    };
    collectMounts(parsed.source);
  }

  // Transitively propagate prefixes (bounded fixed-point)
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const edge of routerMountEdges) {
      const fromPrefix = fileMountPrefixes.get(edge.fromFile) ?? '';
      const combined = joinRoutePath(fromPrefix, edge.mountPrefix);
      const prev = fileMountPrefixes.get(edge.toFile);
      if (prev !== combined) {
        fileMountPrefixes.set(edge.toFile, combined);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Step 2: Extract routes, middleware, and router mounts for each file
  for (const parsed of parsedSources) {
    const receivers = new Set<string>();
    const prefixes = new Map<string, string>();
    const basePrefix = fileMountPrefixes.get(parsed.file.path) ?? '';

    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isCallExpression(node.initializer) || ts.isNewExpression(node.initializer))
      ) {
        const expression = node.initializer.expression;
        const isExpressFactory =
          ts.isIdentifier(expression) && (expression.text === 'express' || expression.text === 'Router');
        const isRouterFactory =
          ts.isPropertyAccessExpression(expression) && expression.name.text === 'Router';
        if (isExpressFactory || isRouterFactory) {
          receivers.add(node.name.text);
          if (basePrefix) prefixes.set(node.name.text, basePrefix);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed.source);

    const importsExpress =
      parsed.source.statements.some(
        (statement) =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === 'express'
      ) ||
      parsed.source.statements.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (item) =>
              item.initializer &&
              ts.isCallExpression(item.initializer) &&
              ts.isIdentifier(item.initializer.expression) &&
              item.initializer.expression.text === 'require' &&
              item.initializer.arguments[0] &&
              ts.isStringLiteral(item.initializer.arguments[0]) &&
              item.initializer.arguments[0].text === 'express'
          )
      );

    if (!importsExpress && receivers.size === 0) continue;

    // Collect intra-file mounts (e.g. app.use('/api', apiRouter))
    const collectIntraMounts = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.name.text === 'use' &&
        receivers.has(node.expression.expression.text) &&
        node.arguments.length > 1 &&
        node.arguments[0] &&
        node.arguments[1] &&
        ts.isIdentifier(node.arguments[1])
      ) {
        const mount = getRoutePathString(node.arguments[0], parsed.source);
        if (mount !== undefined) {
          const parentPrefix = prefixes.get(node.expression.expression.text) ?? basePrefix;
          prefixes.set(node.arguments[1].text, joinRoutePath(parentPrefix, mount));
        }
      }
      ts.forEachChild(node, collectIntraMounts);
    };
    collectIntraMounts(parsed.source);

    // Route discovery
    const routeVisit = (node: ts.Node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
        ts.forEachChild(node, routeVisit);
        return;
      }

      const chained = findRouteChain(node.expression.expression);
      const receiver = ts.isIdentifier(node.expression.expression)
        ? node.expression.expression.text
        : chained?.receiver;
      const methodName = node.expression.name.text;

      if (!receiver || !receivers.has(receiver) || (!expressMethods.has(methodName) && !chained)) {
        ts.forEachChild(node, routeVisit);
        return;
      }

      // Check if this is a router mount to an imported router: app.use('/prefix', importedRouter)
      if (methodName === 'use' && node.arguments.length >= 2) {
        const targetRouterArg = node.arguments[1];
        if (targetRouterArg && ts.isIdentifier(targetRouterArg)) {
          const targetDecl =
            declarations.get(`${parsed.file.path}:${targetRouterArg.text}`) ??
            importedBindings.get(`${parsed.file.path}:${targetRouterArg.text}`);
          if (targetDecl) {
            const start = parsed.source.getLineAndCharacterOfPosition(node.getStart(parsed.source));
            const end = parsed.source.getLineAndCharacterOfPosition(node.end);
            connectRouteRelationship(nodes, edges, {
              snapshotId,
              version,
              type: 'MOUNTS',
              from: parsed.fileId,
              to: targetDecl,
              resolution: 'resolved',
              evidence: {
                path: parsed.file.path,
                startLine: start.line + 1,
                startColumn: start.character + 1,
                endLine: end.line + 1,
                endColumn: end.character + 1,
                name: `use ${targetRouterArg.text}`,
                attributes: { framework: 'express', role: 'mount' },
              },
            });
          }
        }
      }

      const method = node.expression.name.text.toUpperCase();
      const first = chained?.route.arguments[0] ?? node.arguments[0];
      const rawPath = first && getRoutePathString(first, parsed.source);
      const currentPrefix = (receiver ? prefixes.get(receiver) : undefined) ?? basePrefix;
      const path = rawPath === undefined ? undefined : joinRoutePath(currentPrefix, rawPath);
      const hasPath = Boolean(path);

      const start = parsed.source.getLineAndCharacterOfPosition(node.getStart(parsed.source));
      const end = parsed.source.getLineAndCharacterOfPosition(node.end);

      const routeId = createRouteNode(nodes, edges, parsed.fileId, {
        snapshotId,
        version,
        framework: 'express',
        method,
        path: path ?? '<unresolved>',
        filePath: parsed.file.path,
        startLine: start.line + 1,
        startColumn: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        routeKeySuffix: `${node.pos}`,
      });

      const handlerStart = hasPath ? 1 : 0;
      const rawHandlers = node.arguments.slice(handlerStart);
      const handlerArgs = flattenHandlerArguments(rawHandlers);

      handlerArgs.forEach((argument, index) => {
        const handler = resolveHandler(
          snapshotId,
          version,
          parsed,
          argument,
          nodes,
          declarations,
          importedBindings
        );
        const isMiddleware = method === 'USE' || index < handlerArgs.length - 1;
        const argStart = parsed.source.getLineAndCharacterOfPosition(argument.getStart(parsed.source));
        const argEnd = parsed.source.getLineAndCharacterOfPosition(argument.end);

        connectRouteRelationship(nodes, edges, {
          snapshotId,
          version,
          type: isMiddleware ? 'MIDDLEWARE' : 'ROUTE_HANDLER',
          from: routeId,
          to: handler.id,
          resolution: handler.resolution,
          evidence: {
            path: parsed.file.path,
            startLine: argStart.line + 1,
            startColumn: argStart.character + 1,
            endLine: argEnd.line + 1,
            endColumn: argEnd.character + 1,
            attributes: {
              order: index,
              role: isMiddleware ? 'middleware' : 'handler',
              framework: 'express',
            },
          },
        });
      });

      ts.forEachChild(node, routeVisit);
    };

    routeVisit(parsed.source);
  }
}
