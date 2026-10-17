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

interface ParsedGoFile {
  path: string;
  content: string;
  tree: Tree;
  fileId: string;
  packageName: string;
  packageDir: string;
}

const ginMethods = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'Any',
]);

function getCleanString(node: SyntaxNode): string | undefined {
  if (node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal') {
    const text = node.text;
    if (text.startsWith('"') && text.endsWith('"')) {
      return text.slice(1, -1);
    }
    if (text.startsWith('`') && text.endsWith('`')) {
      return text.slice(1, -1);
    }
    return text;
  }
  return undefined;
}

function resolveGoSymbol(
  snapshotId: string,
  version: string,
  parsed: ParsedGoFile,
  argNode: SyntaxNode,
  role: string,
  nodes: Map<string, GraphNode>,
  fileDeclarations: Map<string, string>,
  packageDeclarations: Map<string, string>,
  fileImportedPackages: Map<string, string>
): { id: string; resolution: GraphEdge['resolution'] } {
  let inner = argNode;
  // Unwrap function calls if it's a middleware constructor like gin.Logger() or auth()
  if (inner.type === 'call_expression') {
    const fn = inner.childForFieldName('function');
    if (fn) inner = fn;
  }

  const startLine = inner.startPosition.row + 1;
  const startCol = inner.startPosition.column + 1;
  const endLine = inner.endPosition.row + 1;
  const endCol = inner.endPosition.column + 1;

  if (inner.type === 'identifier') {
    const name = inner.text;
    const direct =
      fileDeclarations.get(`${parsed.path}:${name}`) ??
      packageDeclarations.get(`${parsed.packageDir}:${name}`);
    if (direct) return { id: direct, resolution: 'resolved' };

    const unresolvedId = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-${role}:${parsed.path}:${name}`, {
      path: parsed.path,
      startLine,
      startColumn: startCol,
      endLine,
      endColumn: endCol,
      name,
      attributes: { reason: `${role} declaration is not statically indexed in package` },
    });
    return { id: unresolvedId, resolution: 'unresolved' } as const;
  }

  if (inner.type === 'selector_expression') {
    const pkg = inner.childForFieldName('operand')?.text;
    const field = inner.childForFieldName('field')?.text;
    if (pkg && field) {
      const targetDir = fileImportedPackages.get(`${parsed.path}:${pkg}`);
      if (targetDir) {
        const direct = packageDeclarations.get(`${targetDir}:${field}`);
        if (direct) return { id: direct, resolution: 'resolved' };
      }
      const text = `${pkg}.${field}`;
      const unresolvedId = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-${role}:${parsed.path}:${text}`, {
        path: parsed.path,
        startLine,
        startColumn: startCol,
        endLine,
        endColumn: endCol,
        name: text,
        attributes: { reason: `${role} member is not statically available in imported package` },
      });
      return { id: unresolvedId, resolution: 'unresolved' };
    }
  }

  const unresolvedId = createUnresolvedSymbol(nodes, snapshotId, version, `unresolved-${role}:${parsed.path}:${inner.startIndex}`, {
    path: parsed.path,
    startLine,
    startColumn: startCol,
    endLine,
    endColumn: endCol,
    attributes: { reason: `${role} argument is not statically resolvable` },
  });
  return { id: unresolvedId, resolution: 'unresolved' };
}

export function extractGinFramework(
  snapshotId: string,
  version: string,
  parsedFiles: readonly ParsedGoFile[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  fileDeclarations: Map<string, string>,
  packageDeclarations: Map<string, string>,
  fileImportedPackages: Map<string, string>
) {
  // Receiver map: `${filePath}:${varName}` or `${packageDir}:${varName}` -> prefix
  const ginReceivers = new Map<string, string>();

  // Pass 1: Identify Gin instances (gin.Default(), gin.New()) and Groups
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;

    const findGinInstances = (node: SyntaxNode) => {
      // r := gin.Default() or r := gin.New()
      if (node.type === 'short_var_declaration' || node.type === 'assignment_statement') {
        const leftList = node.childForFieldName('left');
        const rightList = node.childForFieldName('right');
        if (leftList && rightList) {
          for (let i = 0; i < Math.min(leftList.childCount, rightList.childCount); i++) {
            const left = leftList.child(i);
            const right = rightList.child(i);
            if (left?.type === 'identifier' && right?.type === 'call_expression') {
              const fn = right.childForFieldName('function');
              if (fn?.type === 'selector_expression') {
                const pkg = fn.childForFieldName('operand')?.text;
                const method = fn.childForFieldName('field')?.text;

                // Case A: gin.Default() or gin.New()
                if (pkg === 'gin' && (method === 'Default' || method === 'New')) {
                  ginReceivers.set(`${parsed.path}:${left.text}`, '');
                  ginReceivers.set(`${parsed.packageDir}:${left.text}`, '');
                }

                // Case B: v1 := r.Group("/v1")
                if (method === 'Group') {
                  const parentReceiver = fn.childForFieldName('operand')?.text;
                  const parentPrefix =
                    (parentReceiver
                      ? ginReceivers.get(`${parsed.path}:${parentReceiver}`) ??
                        ginReceivers.get(`${parsed.packageDir}:${parentReceiver}`)
                      : undefined) ?? '';

                  let groupPrefix = '';
                  const args = right.childForFieldName('arguments');
                  if (args && args.childCount > 0) {
                    const first = args.children.find(
                      (c) => c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal'
                    );
                    if (first) {
                      groupPrefix = getCleanString(first) ?? '';
                    }
                  }

                  const combined = joinRoutePath(parentPrefix, groupPrefix);
                  ginReceivers.set(`${parsed.path}:${left.text}`, combined);
                  ginReceivers.set(`${parsed.packageDir}:${left.text}`, combined);

                  const fromId =
                    (parentReceiver ? fileDeclarations.get(`${parsed.path}:${parentReceiver}`) : undefined) ??
                    parsed.fileId;
                  const groupId =
                    fileDeclarations.get(`${parsed.path}:${left.text}`) ??
                    createUnresolvedSymbol(nodes, snapshotId, version, `group:${parsed.path}:${left.text}`, {
                      path: parsed.path,
                      startLine: left.startPosition.row + 1,
                      startColumn: left.startPosition.column + 1,
                      endLine: left.endPosition.row + 1,
                      endColumn: left.endPosition.column + 1,
                      name: left.text,
                      attributes: { framework: 'gin', kind: 'router_group', prefix: combined },
                    });

                  connectRouteRelationship(nodes, edges, {
                    snapshotId,
                    version,
                    type: 'MOUNTS',
                    from: fromId,
                    to: groupId,
                    resolution: 'resolved',
                    evidence: {
                      path: parsed.path,
                      startLine: right.startPosition.row + 1,
                      startColumn: right.startPosition.column + 1,
                      endLine: right.endPosition.row + 1,
                      endColumn: right.endPosition.column + 1,
                      name: `Group ${groupPrefix}`,
                      attributes: { framework: 'gin', role: 'mount', prefix: combined },
                    },
                  });
                }
              }
            }
          }
        }
      }

      // Function parameters with *gin.RouterGroup or *gin.Engine: func setup(r *gin.Engine)
      if (node.type === 'parameter_declaration') {
        const typeNode = node.childForFieldName('type');
        if (typeNode && /gin\.(Engine|RouterGroup)/.test(typeNode.text)) {
          const nameNode = node.childForFieldName('name') ?? node.children.find((c) => c.type === 'identifier');
          if (nameNode) {
            ginReceivers.set(`${parsed.path}:${nameNode.text}`, '');
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findGinInstances(child);
      }
    };
    findGinInstances(root);
  }

  // Pass 2: Extract Gin routes and Use middleware
  for (const parsed of parsedFiles) {
    const root = parsed.tree.rootNode;

    const findGinRoutes = (node: SyntaxNode) => {
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'selector_expression') {
          const operand = fn.childForFieldName('operand');
          const field = fn.childForFieldName('field');
          const receiverName = operand?.text;
          const methodName = field?.text;

          const isGinReceiver =
            receiverName &&
            (ginReceivers.has(`${parsed.path}:${receiverName}`) ||
              ginReceivers.has(`${parsed.packageDir}:${receiverName}`));

          if (isGinReceiver && methodName) {
            const currentPrefix =
              ginReceivers.get(`${parsed.path}:${receiverName}`) ??
              ginReceivers.get(`${parsed.packageDir}:${receiverName}`) ??
              '';

            // Case A: r.Use(...) middleware
            if (methodName === 'Use') {
              const argList = node.childForFieldName('arguments');
              if (argList) {
                for (let i = 0; i < argList.childCount; i++) {
                  const arg = argList.child(i);
                  if (!arg || arg.text === '(' || arg.text === ')' || arg.text === ',') continue;
                  const mwSymbol = resolveGoSymbol(
                    snapshotId,
                    version,
                    parsed,
                    arg,
                    'middleware',
                    nodes,
                    fileDeclarations,
                    packageDeclarations,
                    fileImportedPackages
                  );
                  connectRouteRelationship(nodes, edges, {
                    snapshotId,
                    version,
                    type: 'MIDDLEWARE',
                    from: parsed.fileId,
                    to: mwSymbol.id,
                    resolution: mwSymbol.resolution,
                    evidence: {
                      path: parsed.path,
                      startLine: arg.startPosition.row + 1,
                      startColumn: arg.startPosition.column + 1,
                      endLine: arg.endPosition.row + 1,
                      endColumn: arg.endPosition.column + 1,
                      name: `Use ${arg.text}`,
                      attributes: { framework: 'gin', kind: 'middleware' },
                    },
                  });
                }
              }
            }

            // Case B: r.GET("/path", handler)
            if (ginMethods.has(methodName)) {
              const method = methodName === 'Any' ? 'ANY' : methodName.toUpperCase();
              const argList = node.childForFieldName('arguments');
              let rawPath: string | undefined;
              const handlers: SyntaxNode[] = [];

              if (argList) {
                for (let i = 0; i < argList.childCount; i++) {
                  const arg = argList.child(i);
                  if (!arg || arg.text === '(' || arg.text === ')' || arg.text === ',') continue;
                  if (!rawPath && (arg.type === 'interpreted_string_literal' || arg.type === 'raw_string_literal')) {
                    rawPath = getCleanString(arg);
                  } else {
                    handlers.push(arg);
                  }
                }
              }

              const resolvedPath = rawPath !== undefined ? joinRoutePath(currentPrefix, rawPath) : '<unresolved>';

              const routeId = createRouteNode(nodes, edges, parsed.fileId, {
                snapshotId,
                version,
                framework: 'gin',
                method,
                path: resolvedPath,
                filePath: parsed.path,
                startLine: node.startPosition.row + 1,
                startColumn: node.startPosition.column + 1,
                endLine: node.endPosition.row + 1,
                endColumn: node.endPosition.column + 1,
                routeKeySuffix: `${node.startIndex}:${method}`,
              });

              handlers.forEach((hNode, idx) => {
                const isMiddleware = idx < handlers.length - 1;
                const role = isMiddleware ? 'middleware' : 'handler';
                const resolved = resolveGoSymbol(
                  snapshotId,
                  version,
                  parsed,
                  hNode,
                  role,
                  nodes,
                  fileDeclarations,
                  packageDeclarations,
                  fileImportedPackages
                );

                connectRouteRelationship(nodes, edges, {
                  snapshotId,
                  version,
                  type: isMiddleware ? 'MIDDLEWARE' : 'ROUTE_HANDLER',
                  from: routeId,
                  to: resolved.id,
                  resolution: resolved.resolution,
                  evidence: {
                    path: parsed.path,
                    startLine: hNode.startPosition.row + 1,
                    startColumn: hNode.startPosition.column + 1,
                    endLine: hNode.endPosition.row + 1,
                    endColumn: hNode.endPosition.column + 1,
                    name: hNode.text,
                    attributes: {
                      order: idx,
                      role,
                      framework: 'gin',
                    },
                  },
                });
              });
            }
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) findGinRoutes(child);
      }
    };
    findGinRoutes(root);
  }
}
