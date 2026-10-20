import ts from 'typescript';
import { createHash } from 'node:crypto';
import {
  analyzerVersion,
  createEdgeId,
  createNodeId,
  graphSchemaVersion,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type ResolutionStatus,
  type SourceEvidence,
} from '../model.js';

export function joinRoutePath(prefix: string, path: string): string {
  const left = (prefix ?? '').trim();
  const right = (path ?? '').trim();
  if (!left || left === '/') return right ? (right.startsWith('/') ? right : `/${right}`) : '/';
  if (!right || right === '/') return left.startsWith('/') ? left : `/${left}`;

  const cleanLeft = left.replace(/\/+$/, '');
  const cleanRight = right.replace(/^\/+/, '');
  return `${cleanLeft.startsWith('/') ? cleanLeft : `/${cleanLeft}`}/${cleanRight}`;
}

export interface RouteFactParams {
  snapshotId: string;
  version: string;
  framework: string;
  method: string;
  path: string;
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  routeKeySuffix?: string;
  attributes?: Record<string, string | number | boolean>;
}

export function createRouteNode(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  fileId: string,
  params: RouteFactParams
): string {
  const method = params.method.toUpperCase();
  const rawPath = params.path;
  const isUnresolvedPath = rawPath === '<unresolved>' || !rawPath;
  const path = isUnresolvedPath ? '<unresolved>' : params.path;
  const suffix = params.routeKeySuffix ?? `${params.startLine}:${params.startColumn}`;
  const routeKey = `${params.filePath}:${suffix}:${method}:${path}`;

  const routeEvidence: SourceEvidence = {
    path: params.filePath,
    startLine: params.startLine,
    startColumn: params.startColumn,
    endLine: params.endLine,
    endColumn: params.endColumn,
    name: `${method} ${path}`,
    attributes: {
      framework: params.framework,
      method,
      path,
      kind: method === 'USE' ? 'middleware' : 'endpoint',
      ...(isUnresolvedPath ? { reason: 'route path is not statically resolvable' } : {}),
      ...(params.attributes ?? {}),
    },
  };

  const routeId = createNodeId(params.snapshotId, 'route', routeKey, params.version);
  nodes.set(routeId, {
    id: routeId,
    type: 'route',
    snapshotId: params.snapshotId,
    analyzerVersion: params.version,
    key: routeKey,
    evidence: routeEvidence,
  });

  const containsEdgeId = createEdgeId(params.snapshotId, 'CONTAINS', fileId, routeId, params.version, routeEvidence);
  edges.set(containsEdgeId, {
    id: containsEdgeId,
    type: 'CONTAINS',
    snapshotId: params.snapshotId,
    analyzerVersion: params.version,
    from: fileId,
    to: routeId,
    resolution: 'observed',
    evidence: routeEvidence,
  });

  return routeId;
}

export function connectRouteRelationship(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  params: {
    snapshotId: string;
    version: string;
    type: EdgeType;
    from: string;
    to: string;
    resolution: ResolutionStatus;
    evidence: SourceEvidence;
  }
) {
  const edgeId = createEdgeId(params.snapshotId, params.type, params.from, params.to, params.version, params.evidence);
  edges.set(edgeId, {
    id: edgeId,
    type: params.type,
    snapshotId: params.snapshotId,
    analyzerVersion: params.version,
    from: params.from,
    to: params.to,
    resolution: params.resolution,
    evidence: params.evidence,
  });
}

import { createPayloadNodeId, addDataFlowEdge } from '../dataflow.js';
export { createPayloadNodeId, addDataFlowEdge };

export function createUnresolvedSymbol(
  nodes: Map<string, GraphNode>,
  snapshotId: string,
  version: string,
  key: string,
  evidence: SourceEvidence
): string {
  const symId = createNodeId(snapshotId, 'symbol', key, version);
  if (!nodes.has(symId)) {
    nodes.set(symId, {
      id: symId,
      type: 'symbol',
      snapshotId,
      analyzerVersion: version,
      key,
      evidence,
    });
  }
  return symId;
}

export function extractExpressFastifyEntrypointFlow(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  snapshotId: string,
  version: string,
  routeId: string,
  parsed: { file: { path: string }; source: ts.SourceFile },
  handlerArg: ts.Expression,
  handlerSymbolId?: string
): void {
  // If handler is an arrow function or function expression
  if (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg)) {
    const reqParam = handlerArg.parameters[0];
    if (reqParam && ts.isIdentifier(reqParam.name)) {
      const reqName = reqParam.name.text;
      const start = parsed.source.getLineAndCharacterOfPosition(reqParam.getStart(parsed.source));
      const end = parsed.source.getLineAndCharacterOfPosition(reqParam.end);
      const reqEv: SourceEvidence = {
        path: parsed.file.path,
        startLine: start.line + 1,
        startColumn: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        name: reqName,
        attributes: { kind: 'parameter', channel: 'entrypoint' },
      };

      // Connect route to request parameter
      if (handlerSymbolId) {
        // Find parameter node in nodes matching parameterIndex: 0 and functionName
        const paramNode = Array.from(nodes.values()).find(
          (n) =>
            n.evidence?.path === parsed.file.path &&
            n.evidence?.attributes?.kind === 'parameter' &&
            n.evidence?.attributes?.parameterIndex === 0 &&
            n.evidence?.name === reqName
        );
        if (paramNode) {
          addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', routeId, paramNode.id, 'observed', version, reqEv);
        }
      }

      // Inspect accesses to req.params, req.query, req.body, req.headers in body
      const inspectBody = (node: ts.Node) => {
        // Pattern 1: const userId = req.params.id (or req.body, req.query, req.headers)
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const varName = node.name.text;
          const init = node.initializer;

          if (
            ts.isPropertyAccessExpression(init) &&
            ts.isPropertyAccessExpression(init.expression) &&
            ts.isIdentifier(init.expression.expression) &&
            init.expression.expression.text === reqName
          ) {
            const sourceKind = init.expression.name.text; // 'params' | 'query' | 'body' | 'headers'
            const fieldName = init.name.text; // 'id'

            const payloadId = createPayloadNodeId(snapshotId, version, routeId, sourceKind, fieldName);
            const pStart = parsed.source.getLineAndCharacterOfPosition(init.getStart(parsed.source));
            const pEnd = parsed.source.getLineAndCharacterOfPosition(init.end);
            const payloadEv: SourceEvidence = {
              path: parsed.file.path,
              startLine: pStart.line + 1,
              startColumn: pStart.character + 1,
              endLine: pEnd.line + 1,
              endColumn: pEnd.character + 1,
              name: `${reqName}.${sourceKind}.${fieldName}`,
              attributes: { kind: 'entrypoint_payload', source: sourceKind, fieldName },
            };

            if (!nodes.has(payloadId)) {
              nodes.set(payloadId, {
                id: payloadId,
                type: 'symbol',
                snapshotId,
                analyzerVersion: version,
                key: `${routeId}:payload:${sourceKind}:${fieldName}`,
                evidence: payloadEv,
              });
            }

            addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', routeId, payloadId, 'observed', version, payloadEv);

            // Connect payload -> local variable
            const varNode = Array.from(nodes.values()).find(
              (n) =>
                n.evidence?.path === parsed.file.path &&
                n.evidence?.attributes?.kind === 'variable' &&
                n.evidence?.name === varName &&
                n.evidence?.startLine === pStart.line + 1
            );
            if (varNode) {
              const flowEv: SourceEvidence = {
                path: parsed.file.path,
                startLine: pStart.line + 1,
                startColumn: pStart.character + 1,
                endLine: pEnd.line + 1,
                endColumn: pEnd.character + 1,
                attributes: { channel: 'assignment', transformation: 'property_access', property: fieldName },
              };
              addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', payloadId, varNode.id, 'resolved', version, flowEv);
            }
          } else if (
            ts.isPropertyAccessExpression(init) &&
            ts.isIdentifier(init.expression) &&
            init.expression.text === reqName
          ) {
            // const body = req.body;
            const sourceKind = init.name.text;
            const payloadId = createPayloadNodeId(snapshotId, version, routeId, sourceKind);
            const pStart = parsed.source.getLineAndCharacterOfPosition(init.getStart(parsed.source));
            const pEnd = parsed.source.getLineAndCharacterOfPosition(init.end);
            const payloadEv: SourceEvidence = {
              path: parsed.file.path,
              startLine: pStart.line + 1,
              startColumn: pStart.character + 1,
              endLine: pEnd.line + 1,
              endColumn: pEnd.character + 1,
              name: `${reqName}.${sourceKind}`,
              attributes: { kind: 'entrypoint_payload', source: sourceKind },
            };

            if (!nodes.has(payloadId)) {
              nodes.set(payloadId, {
                id: payloadId,
                type: 'symbol',
                snapshotId,
                analyzerVersion: version,
                key: `${routeId}:payload:${sourceKind}`,
                evidence: payloadEv,
              });
            }

            addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', routeId, payloadId, 'observed', version, payloadEv);

            const varNode = Array.from(nodes.values()).find(
              (n) =>
                n.evidence?.path === parsed.file.path &&
                n.evidence?.attributes?.kind === 'variable' &&
                n.evidence?.name === varName &&
                n.evidence?.startLine === pStart.line + 1
            );
            if (varNode) {
              const flowEv: SourceEvidence = {
                path: parsed.file.path,
                startLine: pStart.line + 1,
                startColumn: pStart.character + 1,
                endLine: pEnd.line + 1,
                endColumn: pEnd.character + 1,
                attributes: { channel: 'assignment', transformation: 'identity' },
              };
              addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', payloadId, varNode.id, 'resolved', version, flowEv);
            }
          }
        }

        // Pattern 2: Destructuring const { id } = req.params;
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
          const init = node.initializer;
          if (
            ts.isPropertyAccessExpression(init) &&
            ts.isIdentifier(init.expression) &&
            init.expression.text === reqName
          ) {
            const sourceKind = init.name.text; // 'params' | 'query' | 'body'

            for (const elem of node.name.elements) {
              if (ts.isIdentifier(elem.name)) {
                const elemName = elem.name.text;
                const prop = elem.propertyName && ts.isIdentifier(elem.propertyName) ? elem.propertyName.text : elemName;
                const payloadId = createPayloadNodeId(snapshotId, version, routeId, sourceKind, prop);
                const pStart = parsed.source.getLineAndCharacterOfPosition(elem.getStart(parsed.source));
                const pEnd = parsed.source.getLineAndCharacterOfPosition(elem.end);
                const payloadEv: SourceEvidence = {
                  path: parsed.file.path,
                  startLine: pStart.line + 1,
                  startColumn: pStart.character + 1,
                  endLine: pEnd.line + 1,
                  endColumn: pEnd.character + 1,
                  name: `${reqName}.${sourceKind}.${prop}`,
                  attributes: { kind: 'entrypoint_payload', source: sourceKind, fieldName: prop },
                };

                if (!nodes.has(payloadId)) {
                  nodes.set(payloadId, {
                    id: payloadId,
                    type: 'symbol',
                    snapshotId,
                    analyzerVersion: version,
                    key: `${routeId}:payload:${sourceKind}:${prop}`,
                    evidence: payloadEv,
                  });
                }

                addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', routeId, payloadId, 'observed', version, payloadEv);

                const varNode = Array.from(nodes.values()).find(
                  (n) =>
                    n.evidence?.path === parsed.file.path &&
                    n.evidence?.attributes?.kind === 'variable' &&
                    n.evidence?.name === elemName &&
                    n.evidence?.startLine === pStart.line + 1
                );
                if (varNode) {
                  const flowEv: SourceEvidence = {
                    path: parsed.file.path,
                    startLine: pStart.line + 1,
                    startColumn: pStart.character + 1,
                    endLine: pEnd.line + 1,
                    endColumn: pEnd.character + 1,
                    attributes: { channel: 'destructure', transformation: 'destructure', property: prop },
                  };
                  addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', payloadId, varNode.id, 'resolved', version, flowEv);
                }
              }
            }
          }
        }

        ts.forEachChild(node, inspectBody);
      };

      inspectBody(handlerArg.body);
    }
  } else if (handlerSymbolId) {
    // Handler is a named function/method reference (e.g. user.load)
    // Connect route -> handler's parameter 0 (if present) or handler symbol
    const paramNode = Array.from(nodes.values()).find(
      (n) =>
        n.evidence?.attributes?.kind === 'parameter' &&
        n.evidence?.attributes?.parameterIndex === 0 &&
        edges.has(createEdgeId(snapshotId, 'DECLARES', handlerSymbolId, n.id, version, n.evidence!))
    );
    const targetId = paramNode ? paramNode.id : handlerSymbolId;
    const start = parsed.source.getLineAndCharacterOfPosition(handlerArg.getStart(parsed.source));
    const end = parsed.source.getLineAndCharacterOfPosition(handlerArg.end);
    const ev: SourceEvidence = {
      path: parsed.file.path,
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      attributes: { channel: 'entrypoint' },
    };
    addDataFlowEdge(edges, snapshotId, 'FLOWS_TO', routeId, targetId, 'observed', version, ev);
  }
}
