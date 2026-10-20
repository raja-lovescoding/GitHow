import type { Tree, SyntaxNode } from 'web-tree-sitter';
import {
  type GraphEdge,
  type GraphNode,
} from '../model.js';
import {
  connectRouteRelationship,
  createRouteNode,
  createUnresolvedSymbol,
  joinRoutePath,
  createPayloadNodeId,
  addDataFlowEdge,
} from './common.js';

interface ParsedPyFile {
  path: string;
  content: string;
  tree: Tree;
  fileId: string;
}

function getCleanString(node: SyntaxNode): string | undefined {
  if (node.type === 'string') {
    const text = node.text;
    if (text.startsWith('"""') || text.startsWith("'''")) {
      return text.slice(3, -3);
    }
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1);
    }
    return text;
  }
  return undefined;
}

const fastApiMethods = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
]);

function extractDependsTarget(node: SyntaxNode): string | undefined {
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.text === 'Depends' || fn?.text?.endsWith('.Depends')) {
      const args = node.childForFieldName('arguments');
      if (args && args.childCount > 0) {
        for (let i = 0; i < args.childCount; i++) {
          const arg = args.child(i);
          if (!arg || arg.text === '(' || arg.text === ')' || arg.text === ',') continue;
          if (arg.type === 'identifier' || arg.type === 'attribute') {
            return arg.text;
          }
        }
      }
    }
  }
  return undefined;
}

export function extractFastApiFramework(
  snapshotId: string,
  version: string,
  parsedFiles: readonly ParsedPyFile[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  fileDeclarations: Map<string, string>,
  fileImportedBindings: Map<string, string>
) {
  // APIRouter declarations: routerVar -> ownPrefix
  const routerDefs = new Map<string, { ownPrefix: string; file: string }>();
  // Mounted router prefixes from include_router: routerVar -> mountedPrefix
  const routerMountPrefixes = new Map<string, string>();

  // Stage 1: Index all APIRouter declarations across all files
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;
    const findRouters = (node: SyntaxNode) => {
      if (node.type === 'assignment') {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left && right && right.type === 'call') {
          const fn = right.childForFieldName('function');
          const fnName = fn?.text;
          if (fnName === 'APIRouter' || fnName?.endsWith('.APIRouter')) {
            let ownPrefix = '';
            const argList = right.childForFieldName('arguments');
            if (argList) {
              for (let i = 0; i < argList.childCount; i++) {
                const arg = argList.child(i);
                if (arg?.type === 'keyword_argument') {
                  const kName = arg.childForFieldName('name')?.text;
                  const val = arg.childForFieldName('value');
                  if (kName === 'prefix' && val) {
                    ownPrefix = getCleanString(val) ?? '';
                  }
                }
              }
            }
            routerDefs.set(`${parsed.path}:${left.text}`, { ownPrefix, file: parsed.path });
            routerDefs.set(left.text, { ownPrefix, file: parsed.path });
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findRouters(child);
      }
    };
    findRouters(root);
  }

  // Stage 2: Process all include_router calls across all files
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;
    const findMounts = (node: SyntaxNode) => {
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'include_router') {
          const argList = node.childForFieldName('arguments');
          if (argList && argList.childCount > 0) {
            let routerName: string | undefined;
            let incPrefix = '';
            for (let i = 0; i < argList.childCount; i++) {
              const arg = argList.child(i);
              if (!arg || arg.text === '(' || arg.text === ')' || arg.text === ',') continue;
              if (arg.type === 'keyword_argument') {
                const kName = arg.childForFieldName('name')?.text;
                const val = arg.childForFieldName('value');
                if (kName === 'prefix' && val) {
                  incPrefix = getCleanString(val) ?? '';
                }
              } else if (!routerName && (arg.type === 'identifier' || arg.type === 'attribute')) {
                routerName = arg.text.includes('.') ? arg.text.split('.').pop() : arg.text;
              }
            }

            if (routerName) {
              const rInfo = routerDefs.get(`${parsed.path}:${routerName}`) ?? routerDefs.get(routerName);
              const combined = joinRoutePath(incPrefix, rInfo?.ownPrefix ?? '');
              routerMountPrefixes.set(routerName, combined);
              if (rInfo) {
                routerMountPrefixes.set(`${rInfo.file}:${routerName}`, combined);
              }

              // Emit MOUNTS edge
              const targetSym =
                fileDeclarations.get(`${parsed.path}:${routerName}`) ??
                fileImportedBindings.get(`${parsed.path}:${routerName}`);
              if (targetSym) {
                connectRouteRelationship(nodes, edges, {
                  snapshotId,
                  version,
                  type: 'MOUNTS',
                  from: parsed.fileId,
                  to: targetSym,
                  resolution: 'resolved',
                  evidence: {
                    path: parsed.path,
                    startLine: node.startPosition.row + 1,
                    startColumn: node.startPosition.column + 1,
                    endLine: node.endPosition.row + 1,
                    endColumn: node.endPosition.column + 1,
                    name: `include_router ${routerName}`,
                    attributes: { framework: 'fastapi', role: 'mount', prefix: combined },
                  },
                });
              }
            }
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findMounts(child);
      }
    };
    findMounts(root);
  }

  // Pass 2: Extract routes, dependencies, and middleware
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;

    const findFastApiRoutes = (node: SyntaxNode) => {
      // Check middleware calls: app.add_middleware(CORSMiddleware, ...)
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'add_middleware') {
          const args = node.childForFieldName('arguments');
          const firstArg = args?.children.find((c) => c.type === 'identifier' || c.type === 'attribute');
          if (firstArg) {
            const mwName = firstArg.text;
            const mwSym =
              fileDeclarations.get(`${parsed.path}:${mwName}`) ??
              fileImportedBindings.get(`${parsed.path}:${mwName}`);
            const targetId = mwSym ?? createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-middleware:${parsed.path}:${mwName}`, {
              path: parsed.path,
              startLine: firstArg.startPosition.row + 1,
              startColumn: firstArg.startPosition.column + 1,
              endLine: firstArg.endPosition.row + 1,
              endColumn: firstArg.endPosition.column + 1,
              name: mwName,
              attributes: { reason: 'middleware class is not statically available' },
            });
            connectRouteRelationship(nodes, edges, {
              snapshotId,
              version,
              type: 'MIDDLEWARE',
              from: parsed.fileId,
              to: targetId,
              resolution: mwSym ? 'resolved' : 'unresolved',
              evidence: {
                path: parsed.path,
                startLine: node.startPosition.row + 1,
                startColumn: node.startPosition.column + 1,
                endLine: node.endPosition.row + 1,
                endColumn: node.endPosition.column + 1,
                name: `add_middleware ${mwName}`,
                attributes: { framework: 'fastapi', kind: 'middleware' },
              },
            });
          }
        }
      }

      if (node.type === 'decorated_definition') {
        const funcDef = node.childForFieldName('definition') ?? node.children.find((c) => c.type === 'function_definition');
        if (!funcDef) return;

        const funcNameNode = funcDef.childForFieldName('name');
        const funcName = funcNameNode?.text;
        if (!funcName) return;

        const handlerSymId = fileDeclarations.get(`${parsed.path}:${funcName}`);

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === 'decorator') {
            const callNode = child.children.find((c) => c.type === 'call');

            // Check @app.middleware('http')
            if (callNode) {
              const fn = callNode.childForFieldName('function');
              if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'middleware') {
                if (handlerSymId) {
                  connectRouteRelationship(nodes, edges, {
                    snapshotId,
                    version,
                    type: 'MIDDLEWARE',
                    from: parsed.fileId,
                    to: handlerSymId,
                    resolution: 'resolved',
                    evidence: {
                      path: parsed.path,
                      startLine: child.startPosition.row + 1,
                      startColumn: child.startPosition.column + 1,
                      endLine: child.endPosition.row + 1,
                      endColumn: child.endPosition.column + 1,
                      name: `middleware ${funcName}`,
                      attributes: { framework: 'fastapi', kind: 'middleware' },
                    },
                  });
                }
              }
            }

            if (callNode) {
              const fn = callNode.childForFieldName('function');
              if (fn?.type === 'attribute') {
                const receiverName = fn.childForFieldName('object')?.text;
                const methodName = fn.childForFieldName('attribute')?.text?.toLowerCase();

                if (methodName && fastApiMethods.has(methodName) && receiverName) {
                  const method = methodName.toUpperCase();
                  const rMount =
                    routerMountPrefixes.get(`${parsed.path}:${receiverName}`) ??
                    routerMountPrefixes.get(receiverName);
                  const rOwn =
                    routerDefs.get(`${parsed.path}:${receiverName}`)?.ownPrefix ??
                    routerDefs.get(receiverName)?.ownPrefix ??
                    '';
                  const basePrefix = rMount || rOwn || '';

                  // Parse route path and decorator dependencies
                  const argList = callNode.childForFieldName('arguments');
                  let rawPath: string | undefined;
                  const decoratorDependencies: string[] = [];

                  if (argList) {
                    for (let j = 0; j < argList.childCount; j++) {
                      const arg = argList.child(j);
                      if (!arg || arg.text === '(' || arg.text === ')' || arg.text === ',') continue;
                      if (!rawPath && arg.type === 'string') {
                        rawPath = getCleanString(arg);
                      } else if (arg.type === 'keyword_argument') {
                        const kName = arg.childForFieldName('name')?.text;
                        const val = arg.childForFieldName('value');
                        if (kName === 'dependencies' && val && val.type === 'list') {
                          for (let m = 0; m < val.childCount; m++) {
                            const depItem = val.child(m);
                            if (depItem) {
                              const target = extractDependsTarget(depItem);
                              if (target) decoratorDependencies.push(target);
                            }
                          }
                        }
                      }
                    }
                  }

                  const resolvedPath = rawPath !== undefined ? joinRoutePath(basePrefix, rawPath) : '<unresolved>';

                  const routeId = createRouteNode(nodes, edges, parsed.fileId, {
                    snapshotId,
                    version,
                    framework: 'fastapi',
                    method,
                    path: resolvedPath,
                    filePath: parsed.path,
                    startLine: child.startPosition.row + 1,
                    startColumn: child.startPosition.column + 1,
                    endLine: child.endPosition.row + 1,
                    endColumn: child.endPosition.column + 1,
                    routeKeySuffix: `${funcDef.startIndex}:${method}`,
                  });

                  // Connect handler
                  if (handlerSymId) {
                    connectRouteRelationship(nodes, edges, {
                      snapshotId,
                      version,
                      type: 'ROUTE_HANDLER',
                      from: routeId,
                      to: handlerSymId,
                      resolution: 'resolved',
                      evidence: {
                        path: parsed.path,
                        startLine: funcDef.startPosition.row + 1,
                        startColumn: funcDef.startPosition.column + 1,
                        endLine: funcDef.endPosition.row + 1,
                        endColumn: funcDef.endPosition.column + 1,
                        name: funcName,
                        attributes: { role: 'handler', framework: 'fastapi' },
                      },
                    });
                  } else {
                    const unresolvedId = createUnresolvedSymbol(
                      nodes,
                      snapshotId,
                      version,
                      `unresolved-handler:${parsed.path}:${funcName}`,
                      {
                        path: parsed.path,
                        startLine: funcDef.startPosition.row + 1,
                        startColumn: funcDef.startPosition.column + 1,
                        endLine: funcDef.endPosition.row + 1,
                        endColumn: funcDef.endPosition.column + 1,
                        name: funcName,
                        attributes: { reason: 'handler definition is not statically indexed' },
                      }
                    );
                    connectRouteRelationship(nodes, edges, {
                      snapshotId,
                      version,
                      type: 'ROUTE_HANDLER',
                      from: routeId,
                      to: unresolvedId,
                      resolution: 'unresolved',
                      evidence: {
                        path: parsed.path,
                        startLine: funcDef.startPosition.row + 1,
                        startColumn: funcDef.startPosition.column + 1,
                        endLine: funcDef.endPosition.row + 1,
                        endColumn: funcDef.endPosition.column + 1,
                        name: funcName,
                        attributes: { role: 'handler', framework: 'fastapi' },
                      },
                    });
                  }

                  // Connect decorator dependencies: DEPENDS_ON
                  for (const depName of decoratorDependencies) {
                    const depSym =
                      fileDeclarations.get(`${parsed.path}:${depName}`) ??
                      fileImportedBindings.get(`${parsed.path}:${depName}`);
                    const targetId =
                      depSym ??
                      createUnresolvedSymbol(
                        nodes,
                        snapshotId,
                        version,
                        `unresolved-dep:${parsed.path}:${depName}`,
                        {
                          path: parsed.path,
                          startLine: child.startPosition.row + 1,
                          startColumn: child.startPosition.column + 1,
                          endLine: child.endPosition.row + 1,
                          endColumn: child.endPosition.column + 1,
                          name: depName,
                          attributes: { reason: 'dependency function is not statically available' },
                        }
                      );
                    connectRouteRelationship(nodes, edges, {
                      snapshotId,
                      version,
                      type: 'DEPENDS_ON',
                      from: routeId,
                      to: targetId,
                      resolution: depSym ? 'resolved' : 'unresolved',
                      evidence: {
                        path: parsed.path,
                        startLine: child.startPosition.row + 1,
                        startColumn: child.startPosition.column + 1,
                        endLine: child.endPosition.row + 1,
                        endColumn: child.endPosition.column + 1,
                        name: `Depends(${depName})`,
                        attributes: { framework: 'fastapi', role: 'dependency' },
                      },
                    });
                  }

                  // Inspect handler parameters for Depends(...) defaults and data-flow entrypoints
                  const paramList = funcDef.childForFieldName('parameters');
                  if (paramList) {
                    for (let p = 0; p < paramList.childCount; p++) {
                      const param = paramList.child(p);
                      if (!param) continue;

                      let depTarget: string | undefined;
                      if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
                        const val = param.childForFieldName('value');
                        if (val) {
                          depTarget = extractDependsTarget(val);
                          if (depTarget) {
                            const depSym =
                              fileDeclarations.get(`${parsed.path}:${depTarget}`) ??
                              fileImportedBindings.get(`${parsed.path}:${depTarget}`);
                            const targetId =
                              depSym ??
                              createUnresolvedSymbol(
                                nodes,
                                snapshotId,
                                version,
                                `unresolved-dep:${parsed.path}:${depTarget}`,
                                {
                                  path: parsed.path,
                                  startLine: param.startPosition.row + 1,
                                  startColumn: param.startPosition.column + 1,
                                  endLine: param.endPosition.row + 1,
                                  endColumn: param.endPosition.column + 1,
                                  name: depTarget,
                                  attributes: { reason: 'parameter dependency function is not statically available' },
                                }
                              );
                            connectRouteRelationship(nodes, edges, {
                              snapshotId,
                              version,
                              type: 'DEPENDS_ON',
                              from: routeId,
                              to: targetId,
                              resolution: depSym ? 'resolved' : 'unresolved',
                              evidence: {
                                path: parsed.path,
                                startLine: param.startPosition.row + 1,
                                startColumn: param.startPosition.column + 1,
                                endLine: param.endPosition.row + 1,
                                endColumn: param.endPosition.column + 1,
                                name: `Depends(${depTarget})`,
                                attributes: { framework: 'fastapi', role: 'dependency' },
                              },
                            });
                          }
                        }
                      }

                      // Data-flow entrypoint extraction for parameters
                      const paramName = param.childForFieldName('name')?.text ?? (param.type === 'identifier' ? param.text : param.child(0)?.text);
                      if (paramName && paramName !== 'self' && paramName !== 'cls' && !depTarget) {
                        let sourceKind: 'path' | 'query' | 'body' = 'query';
                        const typeNode = param.childForFieldName('type') ?? (param.type === 'typed_parameter' ? param.child(1) : undefined);
                        const typeText = typeNode?.text ?? '';
                        if (resolvedPath.includes(`{${paramName}}`) || resolvedPath.includes(`:${paramName}`)) {
                          sourceKind = 'path';
                        } else if (typeText && (typeText.startsWith('Body') || (/^[A-Z]/.test(typeText) && !['Int', 'Str', 'Float', 'Bool', 'Optional', 'List', 'Dict', 'Any'].includes(typeText)))) {
                          sourceKind = 'body';
                        } else {
                          sourceKind = 'query';
                        }

                        const payloadId = createPayloadNodeId(snapshotId, version, routeId, sourceKind, paramName);
                        const payloadEv = {
                          path: parsed.path,
                          startLine: param.startPosition.row + 1,
                          startColumn: param.startPosition.column + 1,
                          endLine: param.endPosition.row + 1,
                          endColumn: param.endPosition.column + 1,
                          name: `${sourceKind}.${paramName}`,
                          attributes: { kind: 'entrypoint_payload', source: sourceKind, fieldName: paramName },
                        };
                        if (!nodes.has(payloadId)) {
                          nodes.set(payloadId, {
                            id: payloadId,
                            type: 'symbol',
                            snapshotId,
                            analyzerVersion: version,
                            key: `${routeId}:payload:${sourceKind}:${paramName}`,
                            evidence: payloadEv,
                          });
                        }
                        addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', routeId, payloadId, 'observed', version, payloadEv);

                        if (handlerSymId) {
                          const flowEv = {
                            path: parsed.path,
                            startLine: param.startPosition.row + 1,
                            startColumn: param.startPosition.column + 1,
                            endLine: param.endPosition.row + 1,
                            endColumn: param.endPosition.column + 1,
                            name: paramName,
                            attributes: { channel: 'argument_pass', parameterIndex: p, parameterName: paramName },
                          };
                          addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', payloadId, handlerSymId, 'resolved', version, flowEv);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findFastApiRoutes(child);
      }
    };

    findFastApiRoutes(root);
  }
}
