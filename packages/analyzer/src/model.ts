export const graphSchemaVersion = 'rig-v1';
export const analyzerVersion = 'syntax-v1';

export type NodeType = 'snapshot' | 'file' | 'symbol' | 'module';
export type EdgeType = 'CONTAINS' | 'IMPORTS' | 'EXPORTS' | 'DECLARES' | 'CALLS' | 'EXTENDS' | 'IMPLEMENTS';
export type ResolutionStatus = 'resolved' | 'unresolved' | 'observed';

export interface SourceEvidence {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  name?: string;
  reason?: string;
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
