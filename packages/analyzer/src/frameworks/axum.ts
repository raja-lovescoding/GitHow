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
} from './common.js';

interface ParsedRustFile {
  path: string;
  content: string;
  tree: Tree;
  fileId: string;
}

const axumMethodRouterFns = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
  'any',
]);

function getCleanString(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('r#"') && trimmed.endsWith('"#')) {
    return trimmed.slice(3, -2);
  }
  return undefined;
}

function resolveRustHandler(
  snapshotId: string,
  version: string,
  parsed: ParsedRustFile,
  handlerName: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  nodes: Map<string, GraphNode>,
  fileDeclarations: Map<string, string>,
  fileImportedBindings: Map<string, string>
): { id: string; resolution: GraphEdge['resolution'] } {
  const cleanName = handlerName.includes('::') ? handlerName.split('::').pop()! : handlerName;
  const direct =
    fileDeclarations.get(`${parsed.path}:${cleanName}`) ??
    fileImportedBindings.get(`${parsed.path}:${cleanName}`);
  if (direct) return { id: direct, resolution: 'resolved' };

  const unresolvedId = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-handler:${parsed.path}:${handlerName}`, {
    path: parsed.path,
    startLine,
    startColumn: startCol,
    endLine,
    endColumn: endCol,
    name: handlerName,
    attributes: { reason: 'handler definition is not statically indexed in crate' },
  });
  return { id: unresolvedId, resolution: 'unresolved' };
}

function unwindMethodChain(node: SyntaxNode): Array<{ method: string; callNode: SyntaxNode; argsNode: SyntaxNode | null }> {
  const chain: Array<{ method: string; callNode: SyntaxNode; argsNode: SyntaxNode | null }> = [];
  let current: SyntaxNode | null = node;

  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (fn?.type === 'field_expression') {
      const field = fn.childForFieldName('field')?.text;
      if (field) {
        chain.unshift({
          method: field,
          callNode: current,
          argsNode: current.childForFieldName('arguments'),
        });
      }
      current = fn.childForFieldName('value');
    } else {
      break;
    }
  }

  // Verify the base of the chain is Router::new() or a known Router identifier
  if (current) {
    const baseText = current.text;
    if (baseText.includes('Router::new') || baseText.endsWith('Router')) {
      return chain;
    }
  }

  return chain;
}

function extractMethodRouters(node: SyntaxNode): Array<{ method: string; handlerNode: SyntaxNode }> {
  const result: Array<{ method: string; handlerNode: SyntaxNode }> = [];
  let current: SyntaxNode | null = node;

  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    let methodName: string | undefined;
    let nextNode: SyntaxNode | null = null;

    if (fn?.type === 'identifier' || fn?.type === 'scoped_identifier') {
      const name = fn.text.includes('::') ? fn.text.split('::').pop()! : fn.text;
      methodName = name.toLowerCase();
    } else if (fn?.type === 'field_expression') {
      methodName = fn.childForFieldName('field')?.text?.toLowerCase();
      nextNode = fn.childForFieldName('value');
    }

    if (methodName && axumMethodRouterFns.has(methodName)) {
      const args = current.childForFieldName('arguments');
      const handlerArg = args?.children.find((c) => c.type === 'identifier' || c.type === 'scoped_identifier');
      if (handlerArg) {
        result.push({ method: methodName === 'any' ? 'ANY' : methodName.toUpperCase(), handlerNode: handlerArg });
      }
    }

    current = nextNode;
  }

  return result;
}

export function extractAxumFramework(
  snapshotId: string,
  version: string,
  parsedFiles: readonly ParsedRustFile[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  fileDeclarations: Map<string, string>,
  fileImportedBindings: Map<string, string>
) {
  // Map: routerVar -> prefix
  const routerPrefixes = new Map<string, string>();

  // Pass 1: Identify Router assignments and nest prefixes
  // Pass 1: Identify all Router assignments, nest prefixes, and merge calls
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;

    const findAxumRouters = (node: SyntaxNode) => {
      if (node.type === 'let_declaration') {
        const pat = node.childForFieldName('pattern');
        const val = node.childForFieldName('value');
        if (pat && pat.type === 'identifier' && val) {
          const chain = unwindMethodChain(val);
          if (chain.length > 0 || val.text.includes('Router::new')) {
            if (!routerPrefixes.has(`${parsed.path}:${pat.text}`)) {
              routerPrefixes.set(`${parsed.path}:${pat.text}`, '');
            }
          }
        }
      }

      if (node.type === 'call_expression') {
        const chain = unwindMethodChain(node);
        if (chain.length > 0) {
          for (const step of chain) {
            if (step.method === 'nest' && step.argsNode) {
              const pathArg = step.argsNode.children.find((c) => c.type === 'string_literal');
              const routerArg = step.argsNode.children.find((c) => c.type === 'identifier' || c.type === 'scoped_identifier');
              if (pathArg && routerArg) {
                const prefix = getCleanString(pathArg.text) ?? '';
                routerPrefixes.set(`${parsed.path}:${routerArg.text}`, prefix);
                routerPrefixes.set(routerArg.text, prefix);

                // Connect MOUNTS edge
                const targetSym =
                  fileDeclarations.get(`${parsed.path}:${routerArg.text}`) ??
                  fileImportedBindings.get(`${parsed.path}:${routerArg.text}`) ??
                  createUnresolvedSymbol(nodes, snapshotId, version, `router:${parsed.path}:${routerArg.text}`, {
                    path: parsed.path,
                    startLine: routerArg.startPosition.row + 1,
                    startColumn: routerArg.startPosition.column + 1,
                    endLine: routerArg.endPosition.row + 1,
                    endColumn: routerArg.endPosition.column + 1,
                    name: routerArg.text,
                    attributes: { framework: 'axum', role: 'router' },
                  });

                connectRouteRelationship(nodes, edges, {
                  snapshotId,
                  version,
                  type: 'MOUNTS',
                  from: parsed.fileId,
                  to: targetSym,
                  resolution: 'resolved',
                  evidence: {
                    path: parsed.path,
                    startLine: step.callNode.startPosition.row + 1,
                    startColumn: step.callNode.startPosition.column + 1,
                    endLine: step.callNode.endPosition.row + 1,
                    endColumn: step.callNode.endPosition.column + 1,
                    name: `nest ${prefix}`,
                    attributes: { framework: 'axum', role: 'mount', prefix },
                  },
                });
              }
            }

            if (step.method === 'merge' && step.argsNode) {
              const otherRouter = step.argsNode.children.find((c) => c.type === 'identifier' || c.type === 'scoped_identifier');
              if (otherRouter) {
                const targetSym =
                  fileDeclarations.get(`${parsed.path}:${otherRouter.text}`) ??
                  fileImportedBindings.get(`${parsed.path}:${otherRouter.text}`) ??
                  createUnresolvedSymbol(nodes, snapshotId, version, `router:${parsed.path}:${otherRouter.text}`, {
                    path: parsed.path,
                    startLine: otherRouter.startPosition.row + 1,
                    startColumn: otherRouter.startPosition.column + 1,
                    endLine: otherRouter.endPosition.row + 1,
                    endColumn: otherRouter.endPosition.column + 1,
                    name: otherRouter.text,
                    attributes: { framework: 'axum', role: 'router' },
                  });

                connectRouteRelationship(nodes, edges, {
                  snapshotId,
                  version,
                  type: 'MOUNTS',
                  from: parsed.fileId,
                  to: targetSym,
                  resolution: 'resolved',
                  evidence: {
                    path: parsed.path,
                    startLine: step.callNode.startPosition.row + 1,
                    startColumn: step.callNode.startPosition.column + 1,
                    endLine: step.callNode.endPosition.row + 1,
                    endColumn: step.callNode.endPosition.column + 1,
                    name: `merge ${otherRouter.text}`,
                    attributes: { framework: 'axum', role: 'mount' },
                  },
                });
              }
            }
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findAxumRouters(child);
      }
    };
    findAxumRouters(root);
  }

  // Pass 2: Extract Axum routes and layer middleware
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;

    const findAxumRoutes = (node: SyntaxNode) => {
      if (node.type === 'call_expression') {
        const chain = unwindMethodChain(node);
        if (chain.length > 0) {
          // Identify enclosing variable or prefix
          let basePrefix = '';
          const parent = node.parent;
          if (parent?.type === 'let_declaration') {
            const pat = parent.childForFieldName('pattern');
            if (pat?.type === 'identifier') {
              basePrefix = routerPrefixes.get(`${parsed.path}:${pat.text}`) ?? routerPrefixes.get(pat.text) ?? '';
            }
          }

          for (const step of chain) {
            // Case 1: .route("/path", get(handler).post(handler2))
            if (step.method === 'route' && step.argsNode) {
              const pathArg = step.argsNode.children.find((c) => c.type === 'string_literal');
              const rawPath = pathArg ? getCleanString(pathArg.text) : undefined;
              const resolvedPath = rawPath !== undefined ? joinRoutePath(basePrefix, rawPath) : '<unresolved>';

              // Inspect method routers
              const methodCallArgs = step.argsNode.children.filter((c) => c.type === 'call_expression');
              for (const mCall of methodCallArgs) {
                const methodRouters = extractMethodRouters(mCall);
                for (const mr of methodRouters) {
                  const routeId = createRouteNode(nodes, edges, parsed.fileId, {
                    snapshotId,
                    version,
                    framework: 'axum',
                    method: mr.method,
                    path: resolvedPath,
                    filePath: parsed.path,
                    startLine: step.callNode.startPosition.row + 1,
                    startColumn: step.callNode.startPosition.column + 1,
                    endLine: step.callNode.endPosition.row + 1,
                    endColumn: step.callNode.endPosition.column + 1,
                    routeKeySuffix: `${mr.handlerNode.startIndex}:${mr.method}`,
                  });

                  const handler = resolveRustHandler(
                    snapshotId,
                    version,
                    parsed,
                    mr.handlerNode.text,
                    mr.handlerNode.startPosition.row + 1,
                    mr.handlerNode.startPosition.column + 1,
                    mr.handlerNode.endPosition.row + 1,
                    mr.handlerNode.endPosition.column + 1,
                    nodes,
                    fileDeclarations,
                    fileImportedBindings
                  );

                  connectRouteRelationship(nodes, edges, {
                    snapshotId,
                    version,
                    type: 'ROUTE_HANDLER',
                    from: routeId,
                    to: handler.id,
                    resolution: handler.resolution,
                    evidence: {
                      path: parsed.path,
                      startLine: mr.handlerNode.startPosition.row + 1,
                      startColumn: mr.handlerNode.startPosition.column + 1,
                      endLine: mr.handlerNode.endPosition.row + 1,
                      endColumn: mr.handlerNode.endPosition.column + 1,
                      name: mr.handlerNode.text,
                      attributes: { role: 'handler', framework: 'axum' },
                    },
                  });
                }
              }
            }

            // Case 2: .layer(middleware)
            if (step.method === 'layer' && step.argsNode) {
              const mwArg = step.argsNode.children.find(
                (c) => c.type === 'call_expression' || c.type === 'identifier' || c.type === 'scoped_identifier'
              );
              if (mwArg) {
                // Find inner handler if wrapped in from_fn(mw)
                let targetNode = mwArg;
                if (mwArg.type === 'call_expression') {
                  const innerArg = mwArg.childForFieldName('arguments')?.children.find(
                    (c) => c.type === 'identifier' || c.type === 'scoped_identifier'
                  );
                  if (innerArg) targetNode = innerArg;
                }

                const handler = resolveRustHandler(
                  snapshotId,
                  version,
                  parsed,
                  targetNode.text,
                  targetNode.startPosition.row + 1,
                  targetNode.startPosition.column + 1,
                  targetNode.endPosition.row + 1,
                  targetNode.endPosition.column + 1,
                  nodes,
                  fileDeclarations,
                  fileImportedBindings
                );

                connectRouteRelationship(nodes, edges, {
                  snapshotId,
                  version,
                  type: 'MIDDLEWARE',
                  from: parsed.fileId,
                  to: handler.id,
                  resolution: handler.resolution,
                  evidence: {
                    path: parsed.path,
                    startLine: targetNode.startPosition.row + 1,
                    startColumn: targetNode.startPosition.column + 1,
                    endLine: targetNode.endPosition.row + 1,
                    endColumn: targetNode.endPosition.column + 1,
                    name: targetNode.text,
                    attributes: { framework: 'axum', kind: 'middleware' },
                  },
                });
              }
            }
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findAxumRoutes(child);
      }
    };
    findAxumRoutes(root);
  }
}
