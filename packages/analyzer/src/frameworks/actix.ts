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

interface ParsedRustFile {
  path: string;
  content: string;
  tree: Tree;
  fileId: string;
}

const actixAttributeMethods = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'route',
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

function extractPathFromTokenTree(tokenTree: SyntaxNode): string | undefined {
  for (let i = 0; i < tokenTree.childCount; i++) {
    const child = tokenTree.child(i);
    if (child && (child.type === 'string_literal' || child.type === 'raw_string_literal')) {
      const s = getCleanString(child.text);
      if (s) return s;
    }
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

export function extractActixFramework(
  snapshotId: string,
  version: string,
  parsedFiles: readonly ParsedRustFile[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  fileDeclarations: Map<string, string>,
  fileImportedBindings: Map<string, string>
) {
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;

    const findActixItems = (node: SyntaxNode) => {
      // Pattern 1: #[get("/path")] async fn my_handler(...)
      if (node.type === 'attribute_item') {
        const meta = node.children.find((c) => c.type === 'meta_item' || c.type === 'attribute');
        const attrIdent = meta?.childForFieldName('name') ?? meta?.children.find((c) => c.type === 'identifier');
        const macroName = attrIdent?.text?.toLowerCase();

        if (macroName && actixAttributeMethods.has(macroName)) {
          // Look for next sibling that is a function_item
          let funcNode: SyntaxNode | null = node.nextNamedSibling;
          while (funcNode && funcNode.type === 'attribute_item') {
            funcNode = funcNode.nextNamedSibling;
          }

          if (funcNode && funcNode.type === 'function_item') {
            const funcNameNode = funcNode.childForFieldName('name') ?? funcNode.children.find((c) => c.type === 'identifier');
            const funcName = funcNameNode?.text;

            // Extract path from token_tree in meta
            const tokenTree = meta?.children.find((c) => c.type === 'token_tree');
            let rawPath: string | undefined;
            if (tokenTree) {
              rawPath = extractPathFromTokenTree(tokenTree);
            }

            const method = macroName === 'route' ? 'GET' : macroName.toUpperCase();
            const resolvedPath = rawPath !== undefined ? rawPath : '<unresolved>';

            const routeId = createRouteNode(nodes, edges, parsed.fileId, {
              snapshotId,
              version,
              framework: 'actix-web',
              method,
              path: resolvedPath,
              filePath: parsed.path,
              startLine: node.startPosition.row + 1,
              startColumn: node.startPosition.column + 1,
              endLine: node.endPosition.row + 1,
              endColumn: node.endPosition.column + 1,
              routeKeySuffix: `${node.startIndex}:${method}`,
            });

            if (funcName) {
              const handler = resolveRustHandler(
                snapshotId,
                version,
                parsed,
                funcName,
                funcNode.startPosition.row + 1,
                funcNode.startPosition.column + 1,
                funcNode.endPosition.row + 1,
                funcNode.endPosition.column + 1,
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
                  startLine: funcNode.startPosition.row + 1,
                  startColumn: funcNode.startPosition.column + 1,
                  endLine: funcNode.endPosition.row + 1,
                  endColumn: funcNode.endPosition.column + 1,
                  name: funcName,
                  attributes: { role: 'handler', framework: 'actix-web' },
                },
              });

              // Extract Actix Web request extractors (Path<T>, Query<T>, Json<T>)
              const paramList = funcNode.childForFieldName('parameters');
              if (paramList) {
                for (let p = 0; p < paramList.childCount; p++) {
                  const param = paramList.child(p);
                  if (param?.type === 'parameter') {
                    const typeText = param.childForFieldName('type')?.text ?? '';
                    const patText = param.childForFieldName('pattern')?.text ?? 'param';
                    if (typeText.includes('Path') || typeText.includes('Query') || typeText.includes('Json')) {
                      const sourceKind = typeText.includes('Path') ? 'path' : typeText.includes('Query') ? 'query' : 'body';
                      const payloadId = createPayloadNodeId(snapshotId, version, routeId, sourceKind, patText);
                      const payloadEv = {
                        path: parsed.path,
                        startLine: param.startPosition.row + 1,
                        startColumn: param.startPosition.column + 1,
                        endLine: param.endPosition.row + 1,
                        endColumn: param.endPosition.column + 1,
                        name: patText,
                        attributes: { kind: 'entrypoint_payload', source: sourceKind, extractor: typeText },
                      };
                      if (!nodes.has(payloadId)) {
                        nodes.set(payloadId, {
                          id: payloadId,
                          type: 'symbol',
                          snapshotId,
                          analyzerVersion: version,
                          key: `${routeId}:payload:${sourceKind}:${patText}`,
                          evidence: payloadEv,
                        });
                      }
                      addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', routeId, payloadId, 'observed', version, payloadEv);

                      if (handler.resolution === 'resolved') {
                        const flowEv = {
                          path: parsed.path,
                          startLine: param.startPosition.row + 1,
                          startColumn: param.startPosition.column + 1,
                          endLine: param.endPosition.row + 1,
                          endColumn: param.endPosition.column + 1,
                          name: patText,
                          attributes: { channel: 'argument_pass', source: sourceKind, parameterIndex: p },
                        };
                        addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', payloadId, handler.id, 'resolved', version, flowEv);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Pattern 2: web::resource("/path").route(web::get().to(handler))
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'field_expression') {
          const field = fn.childForFieldName('field')?.text;
          if (field === 'route' || field === 'service') {
            const args = node.childForFieldName('arguments');
            const operand = fn.childForFieldName('value');
            const resArgs = operand?.type === 'call_expression' ? operand.childForFieldName('arguments') : null;
            const pathArg =
              args?.children.find((c) => c.type === 'string_literal') ??
              resArgs?.children.find((c) => c.type === 'string_literal');
            const rawPath = pathArg ? getCleanString(pathArg.text) : undefined;

            if (rawPath !== undefined && args) {
                  for (let i = 0; i < args.childCount; i++) {
                    const arg = args.child(i);
                    if (arg?.type === 'call_expression') {
                      const toFn = arg.childForFieldName('function');
                      if (toFn?.type === 'field_expression' && toFn.childForFieldName('field')?.text === 'to') {
                        const toArgs = arg.childForFieldName('arguments');
                        const hNode = toArgs?.children.find((c) => c.type === 'identifier' || c.type === 'scoped_identifier');
                        if (hNode) {
                          const routeId = createRouteNode(nodes, edges, parsed.fileId, {
                            snapshotId,
                            version,
                            framework: 'actix-web',
                            method: 'GET',
                            path: rawPath ?? '<unresolved>',
                            filePath: parsed.path,
                            startLine: node.startPosition.row + 1,
                            startColumn: node.startPosition.column + 1,
                            endLine: node.endPosition.row + 1,
                            endColumn: node.endPosition.column + 1,
                            routeKeySuffix: `${node.startIndex}:GET`,
                          });

                          const handler = resolveRustHandler(
                            snapshotId,
                            version,
                            parsed,
                            hNode.text,
                            hNode.startPosition.row + 1,
                            hNode.startPosition.column + 1,
                            hNode.endPosition.row + 1,
                            hNode.endPosition.column + 1,
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
                              startLine: hNode.startPosition.row + 1,
                              startColumn: hNode.startPosition.column + 1,
                              endLine: hNode.endPosition.row + 1,
                              endColumn: hNode.endPosition.column + 1,
                              name: hNode.text,
                              attributes: { role: 'handler', framework: 'actix-web' },
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
        if (child) findActixItems(child);
      }
    };

    findActixItems(root);
  }
}
