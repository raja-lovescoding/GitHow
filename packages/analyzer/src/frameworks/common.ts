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
