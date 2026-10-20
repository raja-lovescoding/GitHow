import { createHash } from 'node:crypto';

export const graphSchemaVersion = 'rig-v1';
export const analyzerVersion = 'syntax-v1';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const createNodeId = (snapshot: string, type: string, key: string, version: string) =>
  `rig_${hash(`${graphSchemaVersion}\0${version}\0${snapshot}\0${type}\0${key}`)}`;
export const createEdgeId = (snapshot: string, type: string, from: string, to: string, version: string, evidence: SourceEvidence) =>
  `rig_${hash(`${graphSchemaVersion}\0${version}\0${snapshot}\0${type}\0${from}\0${to}\0${evidence.path}\0${evidence.startLine}\0${evidence.startColumn}`)}`;

export type NodeType = 'snapshot' | 'file' | 'symbol' | 'module' | 'route';
export type EdgeType =
  | 'CONTAINS'
  | 'IMPORTS'
  | 'EXPORTS'
  | 'DECLARES'
  | 'CALLS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'ROUTE_HANDLER'
  | 'MIDDLEWARE'
  | 'MOUNTS'
  | 'DEPENDS_ON'
  | 'HOOK'
  | 'PLUGIN';
export type ResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'observed';

export interface SourceEvidence {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  name?: string;
  reason?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  snapshotId: string;
  analyzerVersion: string;
  key: string;
  evidence?: SourceEvidence;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  snapshotId: string;
  analyzerVersion: string;
  from: string;
  to: string;
  resolution: ResolutionStatus;
  evidence: SourceEvidence;
}

export interface Diagnostic {
  path: string;
  message: string;
  startLine?: number;
  startColumn?: number;
}

export interface AnalysisResult {
  schemaVersion: string;
  analyzerVersion: string;
  snapshotId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}
