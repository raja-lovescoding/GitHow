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
  extractExpressFastifyEntrypointFlow,
} from './common.js';

const fastifyMethods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'all',
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

function resolveSymbol(
  snapshotId: string,
  version: string,
  parsed: { file: SourceFile; source: ts.SourceFile },
  expr: ts.Expression,
  role: string,
  nodes: Map<string, GraphNode>,
  declarations: Map<string, string>,
  importedBindings: Map<string, string>
): { id: string; resolution: GraphEdge['resolution'] } {
  let inner = expr;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }

  const start = parsed.source.getLineAndCharacterOfPosition(expr.getStart(parsed.source));
  const end = parsed.source.getLineAndCharacterOfPosition(expr.end);
  const ev: SourceEvidence = {
    path: parsed.file.path,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };

  if (ts.isIdentifier(inner)) {
    const direct =
      declarations.get(`${parsed.file.path}:${inner.text}`) ??
      importedBindings.get(`${parsed.file.path}:${inner.text}`);
    if (direct) return { id: direct, resolution: 'resolved' };
    const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-${role}:${parsed.file.path}:${inner.text}`, {
      ...ev,
      name: inner.text,
      attributes: { reason: `${role} declaration is not statically available` },
    });
    return { id, resolution: 'unresolved' };
  }

  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    const receiver = ts.isIdentifier(inner.expression) ? inner.expression.text : undefined;
    const direct =
      (receiver ? importedBindings.get(`${parsed.file.path}:${receiver}.${inner.name.text}`) : undefined) ??
      declarations.get(`${parsed.file.path}:${inner.name.text}`) ??
      importedBindings.get(`${parsed.file.path}:${inner.name.text}`);
    if (direct) return { id: direct, resolution: 'resolved' };
    const text = inner.getText(parsed.source);
    const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-${role}:${parsed.file.path}:${text}`, {
      ...ev,
      name: text,
      attributes: { reason: `${role} member is not statically available` },
    });
    return { id, resolution: 'unresolved' };
  }

  if (ts.isFunctionExpression(inner) || ts.isArrowFunction(inner)) {
    const key = `inline-${role}:${parsed.file.path}:${inner.pos}`;
    const id = createUnresolvedSymbol(nodes, snapshotId, version, key, {
      ...ev,
      name: `inline ${role}`,
    });
    return { id, resolution: 'observed' };
  }

  const id = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-${role}:${parsed.file.path}:${expr.pos}`, {
    ...ev,
    attributes: { reason: `${role} expression is not statically resolvable` },
  });
  return { id, resolution: 'unresolved' };
}

export function extractFastifyFramework(
  snapshotId: string,
  version: string,
  parsedSources: readonly { file: SourceFile; source: ts.SourceFile; fileId: string }[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  declarations: Map<string, string>,
  importedBindings: Map<string, string>,
  allFilesSet: ReadonlySet<string>
) {
  // Plugin registration and prefix discovery
  const pluginPrefixes = new Map<string, string>(); // pluginName/targetPath -> prefix
  const filePluginPrefixes = new Map<string, string>(); // file -> prefix

  // Discover Fastify instances and register(...) calls
  for (const parsed of parsedSources) {
    const visitPluginRegistrations = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'register' &&
        node.arguments.length >= 1
      ) {
        const pluginArg = node.arguments[0];
        const optionsArg = node.arguments[1];
        let prefix = '';
        if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
          for (const prop of optionsArg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'prefix' &&
              (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
            ) {
              prefix = prop.initializer.text;
            }
          }
        }

        if (pluginArg && ts.isIdentifier(pluginArg)) {
          pluginPrefixes.set(pluginArg.text, prefix);
          // Look up if plugin was imported from another file
          for (const stmt of parsed.source.statements) {
            if (
              ts.isImportDeclaration(stmt) &&
              ts.isStringLiteral(stmt.moduleSpecifier) &&
              (stmt.importClause?.name?.text === pluginArg.text ||
                (stmt.importClause?.namedBindings &&
                  ts.isNamedImports(stmt.importClause.namedBindings) &&
                  stmt.importClause.namedBindings.elements.some((el) => el.name.text === pluginArg.text)))
            ) {
              const target = resolveTsModule(parsed.file.path, stmt.moduleSpecifier.text, allFilesSet);
              if (target) {
                filePluginPrefixes.set(target, joinRoutePath(filePluginPrefixes.get(parsed.file.path) ?? '', prefix));
              }
            }
          }

          // Emit PLUGIN edge
          const targetDecl =
            declarations.get(`${parsed.file.path}:${pluginArg.text}`) ??
            importedBindings.get(`${parsed.file.path}:${pluginArg.text}`);
          const start = parsed.source.getLineAndCharacterOfPosition(node.getStart(parsed.source));
          const end = parsed.source.getLineAndCharacterOfPosition(node.end);
          connectRouteRelationship(nodes, edges, {
            snapshotId,
            version,
            type: 'PLUGIN',
            from: parsed.fileId,
            to: targetDecl ?? createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-plugin:${parsed.file.path}:${pluginArg.text}`, {
              path: parsed.file.path,
              startLine: start.line + 1,
              startColumn: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              name: pluginArg.text,
              attributes: { reason: 'plugin declaration is not statically available' },
            }),
            resolution: targetDecl ? 'resolved' : 'unresolved',
            evidence: {
              path: parsed.file.path,
              startLine: start.line + 1,
              startColumn: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              name: `register ${pluginArg.text}`,
              attributes: { framework: 'fastify', prefix: prefix || '/' },
            },
          });
        }
      }
      ts.forEachChild(node, visitPluginRegistrations);
    };
    visitPluginRegistrations(parsed.source);
  }

  for (const parsed of parsedSources) {
    const fastifyReceivers = new Set<string>();
    const basePrefix = filePluginPrefixes.get(parsed.file.path) ?? '';

    const hasFastifyRequire = (expr: ts.Expression): boolean => {
      let curr = expr;
      while (ts.isCallExpression(curr)) {
        if (ts.isIdentifier(curr.expression) && curr.expression.text === 'require') {
          if (curr.arguments[0] && ts.isStringLiteral(curr.arguments[0]) && curr.arguments[0].text === 'fastify') {
            return true;
          }
        }
        curr = curr.expression;
      }
      return false;
    };

    // Check imports: import Fastify from 'fastify' or require('fastify')
    const importsFastify =
      parsed.source.statements.some(
        (statement) =>
          (ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === 'fastify') ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (item) => item.initializer && hasFastifyRequire(item.initializer)
            ))
      );

    // Identify receivers (app = Fastify(), fastify = Fastify(), or plugin function parameter `fastify`)
    const visitReceivers = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        if (hasFastifyRequire(node.initializer)) {
          fastifyReceivers.add(node.name.text);
        } else if (ts.isCallExpression(node.initializer)) {
          let expr: ts.Expression = node.initializer;
          while (ts.isCallExpression(expr)) {
            if (ts.isIdentifier(expr.expression) && /^(fastify|Fastify)$/i.test(expr.expression.text)) {
              fastifyReceivers.add(node.name.text);
              break;
            }
            expr = expr.expression;
          }
        }
      }
      // Plugin function definition: async function plugin(fastify, opts) { ... }
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
        node.parameters.length >= 1
      ) {
        const firstParam = node.parameters[0];
        if (firstParam && ts.isIdentifier(firstParam.name) && /^(fastify|server|app|instance)$/i.test(firstParam.name.text)) {
          fastifyReceivers.add(firstParam.name.text);
        }
      }
      ts.forEachChild(node, visitReceivers);
    };
    visitReceivers(parsed.source);

    if (!importsFastify && fastifyReceivers.size === 0) continue;

    // Traverse statements for Fastify routes, route objects, addHook, and middleware
    const visitCalls = (node: ts.Node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
        ts.forEachChild(node, visitCalls);
        return;
      }

      const receiver = ts.isIdentifier(node.expression.expression)
        ? node.expression.expression.text
        : undefined;
      const methodName = node.expression.name.text;

      if (!receiver || !fastifyReceivers.has(receiver)) {
        ts.forEachChild(node, visitCalls);
        return;
      }

      const start = parsed.source.getLineAndCharacterOfPosition(node.getStart(parsed.source));
      const end = parsed.source.getLineAndCharacterOfPosition(node.end);

      // Case 1: fastify.addHook('onRequest', hookHandler)
      if (methodName === 'addHook' && node.arguments.length >= 2) {
        const hookNameArg = node.arguments[0];
        const hookHandlerArg = node.arguments[1];
        const hookName = hookNameArg && ts.isStringLiteral(hookNameArg) ? hookNameArg.text : 'hook';

        if (hookHandlerArg) {
          const hookSymbol = resolveSymbol(
            snapshotId,
            version,
            parsed,
            hookHandlerArg,
            'hook',
            nodes,
            declarations,
            importedBindings
          );
          connectRouteRelationship(nodes, edges, {
            snapshotId,
            version,
            type: 'HOOK',
            from: parsed.fileId,
            to: hookSymbol.id,
            resolution: hookSymbol.resolution,
            evidence: {
              path: parsed.file.path,
              startLine: start.line + 1,
              startColumn: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              name: `addHook ${hookName}`,
              attributes: { framework: 'fastify', kind: 'hook', hookName },
            },
          });
        }
        ts.forEachChild(node, visitCalls);
        return;
      }

      // Case 2: fastify.use('/path', middleware) or fastify.use(middleware)
      if (methodName === 'use' && node.arguments.length >= 1) {
        const hasPathArg = node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0]!);
        const rawPath = hasPathArg && ts.isStringLiteral(node.arguments[0]!) ? node.arguments[0]!.text : '/';
        const mwArg = hasPathArg ? node.arguments[1] : node.arguments[0];
        if (mwArg) {
          const mwSymbol = resolveSymbol(
            snapshotId,
            version,
            parsed,
            mwArg,
            'middleware',
            nodes,
            declarations,
            importedBindings
          );
          connectRouteRelationship(nodes, edges, {
            snapshotId,
            version,
            type: 'MIDDLEWARE',
            from: parsed.fileId,
            to: mwSymbol.id,
            resolution: mwSymbol.resolution,
            evidence: {
              path: parsed.file.path,
              startLine: start.line + 1,
              startColumn: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              name: `use middleware`,
              attributes: { framework: 'fastify', kind: 'middleware', path: rawPath },
            },
          });
        }
        ts.forEachChild(node, visitCalls);
        return;
      }

      // Case 3: fastify.route({ method: 'GET', url: '/path', handler, preHandler: [...] })
      if (methodName === 'route' && node.arguments.length >= 1) {
        const routeObj = node.arguments[0];
        if (routeObj && ts.isObjectLiteralExpression(routeObj)) {
          let methods: string[] = ['GET'];
          let rawPath: string | undefined;
          let handlerExpr: ts.Expression | undefined;
          const preHandlers: ts.Expression[] = [];

          for (const prop of routeObj.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              if (prop.name.text === 'method') {
                if (ts.isStringLiteral(prop.initializer)) {
                  methods = [prop.initializer.text.toUpperCase()];
                } else if (ts.isArrayLiteralExpression(prop.initializer)) {
                  methods = prop.initializer.elements
                    .filter((e): e is ts.StringLiteral => ts.isStringLiteral(e))
                    .map((e) => e.text.toUpperCase());
                }
              } else if (prop.name.text === 'url' || prop.name.text === 'path') {
                if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
                  rawPath = prop.initializer.text;
                }
              } else if (prop.name.text === 'handler') {
                handlerExpr = prop.initializer;
              } else if (prop.name.text === 'preHandler' || prop.name.text === 'onRequest') {
                if (ts.isArrayLiteralExpression(prop.initializer)) {
                  preHandlers.push(
                    ...prop.initializer.elements.filter((el): el is ts.Expression => ts.isExpression(el))
                  );
                } else {
                  preHandlers.push(prop.initializer);
                }
              }
            }
          }

          const resolvedPath = rawPath !== undefined ? joinRoutePath(basePrefix, rawPath) : '<unresolved>';

          for (const method of methods) {
            const routeId = createRouteNode(nodes, edges, parsed.fileId, {
              snapshotId,
              version,
              framework: 'fastify',
              method,
              path: resolvedPath,
              filePath: parsed.file.path,
              startLine: start.line + 1,
              startColumn: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              routeKeySuffix: `${node.pos}:${method}`,
            });

            // Connect preHandlers as MIDDLEWARE
            preHandlers.forEach((pre, idx) => {
              const preSym = resolveSymbol(
                snapshotId,
                version,
                parsed,
                pre,
                'middleware',
                nodes,
                declarations,
                importedBindings
              );
              connectRouteRelationship(nodes, edges, {
                snapshotId,
                version,
                type: 'MIDDLEWARE',
                from: routeId,
                to: preSym.id,
                resolution: preSym.resolution,
                evidence: {
                  path: parsed.file.path,
                  startLine: start.line + 1,
                  startColumn: start.character + 1,
                  endLine: end.line + 1,
                  endColumn: end.character + 1,
                  attributes: { order: idx, role: 'middleware', framework: 'fastify' },
                },
              });
            });

            // Connect handler as ROUTE_HANDLER
            if (handlerExpr) {
              const handlerSym = resolveSymbol(
                snapshotId,
                version,
                parsed,
                handlerExpr,
                'handler',
                nodes,
                declarations,
                importedBindings
              );
              connectRouteRelationship(nodes, edges, {
                snapshotId,
                version,
                type: 'ROUTE_HANDLER',
                from: routeId,
                to: handlerSym.id,
                resolution: handlerSym.resolution,
                evidence: {
                  path: parsed.file.path,
                  startLine: start.line + 1,
                  startColumn: start.character + 1,
                  endLine: end.line + 1,
                  endColumn: end.character + 1,
                  attributes: { role: 'handler', framework: 'fastify' },
                },
              });
              extractExpressFastifyEntrypointFlow(
                nodes,
                edges,
                snapshotId,
                version,
                routeId,
                parsed,
                handlerExpr,
                handlerSym.id
              );
            }
          }
        }
        ts.forEachChild(node, visitCalls);
        return;
      }

      // Case 4: fastify.get('/path', [opts,] handler) shorthand
      if (fastifyMethods.has(methodName) && node.arguments.length >= 1) {
        const method = methodName.toUpperCase();
        const pathArg = node.arguments[0];
        const rawPath = pathArg && getRoutePathString(pathArg, parsed.source);
        const resolvedPath = rawPath !== undefined ? joinRoutePath(basePrefix, rawPath) : '<unresolved>';

        const routeId = createRouteNode(nodes, edges, parsed.fileId, {
          snapshotId,
          version,
          framework: 'fastify',
          method,
          path: resolvedPath,
          filePath: parsed.file.path,
          startLine: start.line + 1,
          startColumn: start.character + 1,
          endLine: end.line + 1,
          endColumn: end.character + 1,
          routeKeySuffix: `${node.pos}:${method}`,
        });

        // The handler is typically the last argument; any intermediate options might have preHandler
        const remainingArgs = node.arguments.slice(1);
        let handlerArg: ts.Expression | undefined;
        const middlewareArgs: ts.Expression[] = [];

        if (remainingArgs.length === 1) {
          handlerArg = remainingArgs[0];
        } else if (remainingArgs.length >= 2) {
          const optsArg = remainingArgs[0];
          handlerArg = remainingArgs[remainingArgs.length - 1];
          if (optsArg && ts.isObjectLiteralExpression(optsArg)) {
            for (const prop of optsArg.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                (prop.name.text === 'preHandler' || prop.name.text === 'onRequest')
              ) {
                if (ts.isArrayLiteralExpression(prop.initializer)) {
                  middlewareArgs.push(
                    ...prop.initializer.elements.filter((el): el is ts.Expression => ts.isExpression(el))
                  );
                } else {
                  middlewareArgs.push(prop.initializer);
                }
              }
            }
          }
        }

        middlewareArgs.forEach((mw, idx) => {
          const mwSym = resolveSymbol(
            snapshotId,
            version,
            parsed,
            mw,
            'middleware',
            nodes,
            declarations,
            importedBindings
          );
          connectRouteRelationship(nodes, edges, {
            snapshotId,
            version,
            type: 'MIDDLEWARE',
            from: routeId,
            to: mwSym.id,
            resolution: mwSym.resolution,
            evidence: {
              path: parsed.file.path,
              startLine: start.line + 1,
              startColumn: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              attributes: { order: idx, role: 'middleware', framework: 'fastify' },
            },
          });
        });

        if (handlerArg) {
          const handlerSym = resolveSymbol(
            snapshotId,
            version,
            parsed,
            handlerArg,
            'handler',
            nodes,
            declarations,
            importedBindings
          );
          connectRouteRelationship(nodes, edges, {
            snapshotId,
            version,
            type: 'ROUTE_HANDLER',
            from: routeId,
            to: handlerSym.id,
            resolution: handlerSym.resolution,
            evidence: {
              path: parsed.file.path,
              startLine: start.line + 1,
              startColumn: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              attributes: { role: 'handler', framework: 'fastify' },
            },
          });
          extractExpressFastifyEntrypointFlow(
            nodes,
            edges,
            snapshotId,
            version,
            routeId,
            parsed,
            handlerArg,
            handlerSym.id
          );
        }
      }

      ts.forEachChild(node, visitCalls);
    };

    visitCalls(parsed.source);
  }
}
