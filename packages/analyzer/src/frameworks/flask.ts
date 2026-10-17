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

interface ParsedPyFile {
  path: string;
  content: string;
  tree: Tree;
  fileId: string;
}

function getCleanString(node: SyntaxNode): string | undefined {
  if (node.type === 'string') {
    const text = node.text;
    // Strip quotes ('...', "...", """...""", '''...''')
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

export function extractFlaskFramework(
  snapshotId: string,
  version: string,
  parsedFiles: readonly ParsedPyFile[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  fileDeclarations: Map<string, string>,
  fileImportedBindings: Map<string, string>
) {
  // Map of blueprint varName -> { ownPrefix: string; file: string; symId?: string }
  const blueprintDefs = new Map<string, { ownPrefix: string; file: string }>();
  // Map of blueprint var/file -> mounted prefix from register_blueprint
  const blueprintMountPrefixes = new Map<string, string>();

  // Pass 1: Find Blueprint declarations and register_blueprint calls
  // Stage 1: Index all Blueprint declarations across all files
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;
    const findBlueprints = (node: SyntaxNode) => {
      if (node.type === 'assignment') {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left && right && right.type === 'call') {
          const fn = right.childForFieldName('function');
          const fnName = fn?.text;
          if (fnName === 'Blueprint' || fnName?.endsWith('.Blueprint')) {
            let ownPrefix = '';
            const argList = right.childForFieldName('arguments');
            if (argList) {
              for (let i = 0; i < argList.childCount; i++) {
                const arg = argList.child(i);
                if (arg?.type === 'keyword_argument') {
                  const kName = arg.childForFieldName('name')?.text;
                  const val = arg.childForFieldName('value');
                  if (kName === 'url_prefix' && val) {
                    ownPrefix = getCleanString(val) ?? '';
                  }
                }
              }
            }
            blueprintDefs.set(`${parsed.path}:${left.text}`, { ownPrefix, file: parsed.path });
            blueprintDefs.set(left.text, { ownPrefix, file: parsed.path });
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findBlueprints(child);
      }
    };
    findBlueprints(root);
  }

  // Stage 2: Process all register_blueprint calls across all files
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;
    const findMounts = (node: SyntaxNode) => {
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'register_blueprint') {
          const argList = node.childForFieldName('arguments');
          if (argList && argList.childCount > 0) {
            let bpName: string | undefined;
            let regPrefix = '';
            for (let i = 0; i < argList.childCount; i++) {
              const arg = argList.child(i);
              if (!arg || arg.text === '(' || arg.text === ')' || arg.text === ',') continue;
              if (arg.type === 'keyword_argument') {
                const kName = arg.childForFieldName('name')?.text;
                const val = arg.childForFieldName('value');
                if (kName === 'url_prefix' && val) {
                  regPrefix = getCleanString(val) ?? '';
                }
              } else if (!bpName && (arg.type === 'identifier' || arg.type === 'attribute')) {
                bpName = arg.text.includes('.') ? arg.text.split('.').pop() : arg.text;
              }
            }

            if (bpName) {
              const bpInfo = blueprintDefs.get(`${parsed.path}:${bpName}`) ?? blueprintDefs.get(bpName);
              const combinedPrefix = joinRoutePath(regPrefix, bpInfo?.ownPrefix ?? '');
              blueprintMountPrefixes.set(bpName, combinedPrefix);
              if (bpInfo) {
                blueprintMountPrefixes.set(`${bpInfo.file}:${bpName}`, combinedPrefix);
              }

              // Emit MOUNTS edge
              const targetSym =
                fileDeclarations.get(`${parsed.path}:${bpName}`) ??
                fileImportedBindings.get(`${parsed.path}:${bpName}`);
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
                    name: `register_blueprint ${bpName}`,
                    attributes: { framework: 'flask', role: 'mount', prefix: combinedPrefix },
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

  // Pass 2: Extract decorated route definitions and request hooks
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;

    const findFlaskRoutes = (node: SyntaxNode) => {
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
            const decText = child.text;
            // Check for @app.route(...), @bp.route(...), @api.route(...), @app.get(...), @app.post(...)
            // or hooks: @app.before_request, @app.after_request, @bp.before_request
            const callNode = child.children.find((c) => c.type === 'call');
            const attrNode = child.children.find((c) => c.type === 'attribute');

            // Hook check: @app.before_request or @app.after_request
            const hookCandidate = attrNode ?? callNode?.childForFieldName('function');
            const hookAttrName = hookCandidate?.type === 'attribute' ? hookCandidate.childForFieldName('attribute')?.text : undefined;
            const recognizedHook = hookAttrName && (hookAttrName === 'before_request' || hookAttrName === 'after_request' || hookAttrName === 'teardown_request')
              ? hookAttrName
              : decText.includes('before_request')
                ? 'before_request'
                : decText.includes('after_request')
                  ? 'after_request'
                  : undefined;

            if (recognizedHook) {
              const targetId = handlerSymId ?? createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-hook:${parsed.path}:${funcName}`, {
                path: parsed.path,
                startLine: child.startPosition.row + 1,
                startColumn: child.startPosition.column + 1,
                endLine: child.endPosition.row + 1,
                endColumn: child.endPosition.column + 1,
                name: `${decText} ${funcName}`,
                attributes: { reason: 'hook handler declaration is not statically available' },
              });
              connectRouteRelationship(nodes, edges, {
                snapshotId,
                version,
                type: 'HOOK',
                from: parsed.fileId,
                to: targetId,
                resolution: handlerSymId ? 'resolved' : 'unresolved',
                evidence: {
                  path: parsed.path,
                  startLine: child.startPosition.row + 1,
                  startColumn: child.startPosition.column + 1,
                  endLine: child.endPosition.row + 1,
                  endColumn: child.endPosition.column + 1,
                  name: `${hookCandidate?.text ?? decText} ${funcName}`,
                  attributes: { framework: 'flask', kind: 'hook', hookName: recognizedHook },
                },
              });
            }

            if (callNode) {
              const fn = callNode.childForFieldName('function');
              if (fn?.type === 'attribute') {
                const receiverName = fn.childForFieldName('object')?.text;
                const methodName = fn.childForFieldName('attribute')?.text;

                const isRouteMethod =
                  methodName === 'route' ||
                  methodName === 'get' ||
                  methodName === 'post' ||
                  methodName === 'put' ||
                  methodName === 'delete' ||
                  methodName === 'patch';

                if (isRouteMethod && receiverName) {
                  // Determine prefix
                  const bpMount =
                    blueprintMountPrefixes.get(`${parsed.path}:${receiverName}`) ??
                    blueprintMountPrefixes.get(receiverName);
                  const bpOwn =
                    blueprintDefs.get(`${parsed.path}:${receiverName}`)?.ownPrefix ??
                    blueprintDefs.get(receiverName)?.ownPrefix ??
                    '';
                  const basePrefix = bpMount || bpOwn || '';

                  // Parse route path and methods
                  const argList = callNode.childForFieldName('arguments');
                  let rawPath: string | undefined;
                  let httpMethods = [methodName === 'route' ? 'GET' : methodName.toUpperCase()];

                  if (argList) {
                    for (let j = 0; j < argList.childCount; j++) {
                      const arg = argList.child(j);
                      if (!arg || arg.text === '(' || arg.text === ')' || arg.text === ',') continue;
                      if (!rawPath && arg.type === 'string') {
                        rawPath = getCleanString(arg);
                      } else if (arg.type === 'keyword_argument') {
                        const kName = arg.childForFieldName('name')?.text;
                        const val = arg.childForFieldName('value');
                        if (kName === 'methods' && val && (val.type === 'list' || val.type === 'tuple')) {
                          const customMethods: string[] = [];
                          for (let m = 0; m < val.childCount; m++) {
                            const item = val.child(m);
                            if (item?.type === 'string') {
                              const s = getCleanString(item);
                              if (s) customMethods.push(s.toUpperCase());
                            }
                          }
                          if (customMethods.length > 0) httpMethods = customMethods;
                        }
                      }
                    }
                  }

                  const resolvedPath = rawPath !== undefined ? joinRoutePath(basePrefix, rawPath) : '<unresolved>';

                  for (const method of httpMethods) {
                    const routeId = createRouteNode(nodes, edges, parsed.fileId, {
                      snapshotId,
                      version,
                      framework: 'flask',
                      method,
                      path: resolvedPath,
                      filePath: parsed.path,
                      startLine: child.startPosition.row + 1,
                      startColumn: child.startPosition.column + 1,
                      endLine: child.endPosition.row + 1,
                      endColumn: child.endPosition.column + 1,
                      routeKeySuffix: `${funcDef.startIndex}:${method}`,
                    });

                    // Connect route to decorated handler
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
                          attributes: { role: 'handler', framework: 'flask' },
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
                          attributes: { role: 'handler', framework: 'flask' },
                        },
                      });
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
        if (child) findFlaskRoutes(child);
      }
    };

    findFlaskRoutes(root);
  }
}
