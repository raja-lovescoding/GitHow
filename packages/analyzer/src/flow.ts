import { createHash } from 'node:crypto';
import type { AnalysisResult, GraphEdge, GraphNode, NodeType } from './model.js';

export interface FlowCandidate {
  id: string;
  snapshotId: string;
  method: string;
  path: string;
  nodeId: string;
  evidence?: GraphNode['evidence'];
}

export interface FlowStep {
  id: string;
  nodeId: string;
  type: NodeType;
  role: string;
  label: string;
  resolution: GraphEdge['resolution'];
  evidence?: GraphNode['evidence'];
}

export interface FlowRelationship {
  id: string;
  from: string;
  to: string;
  type: GraphEdge['type'];
  resolution: GraphEdge['resolution'];
  evidence: GraphEdge['evidence'];
}

export interface DiscoveredFlow {
  id: string;
  snapshotId: string;
  candidate: FlowCandidate;
  steps: FlowStep[];
  relationships: FlowRelationship[];
  truncated: boolean;
  limitations: string[];
}

export const flowLimits = { maxDepth: 8, maxFanOut: 6, maxSteps: 80 };

export function findFlowCandidates(graph: Pick<AnalysisResult, 'snapshotId' | 'nodes'>, limit = 100): FlowCandidate[] {
  return graph.nodes.filter((node) => node.type === 'route' && node.evidence?.attributes?.kind !== 'middleware').sort((a, b) => `${a.evidence?.path ?? ''}:${a.evidence?.startLine ?? 0}:${a.id}`.localeCompare(`${b.evidence?.path ?? ''}:${b.evidence?.startLine ?? 0}:${b.id}`)).slice(0, limit).map((node) => ({
    id: `flow_${createHash('sha256').update(`${graph.snapshotId}\0${node.id}`).digest('hex')}`,
    snapshotId: graph.snapshotId,
    method: String(node.evidence?.attributes?.method ?? 'UNKNOWN'),
    path: String(node.evidence?.attributes?.path ?? '<unresolved>'),
    nodeId: node.id,
    evidence: node.evidence,
  }));
}

export type FlowViewMode = 'control' | 'data' | 'all';

export interface FlowOptions extends Partial<typeof flowLimits> {
  view?: FlowViewMode;
}

export function assembleFlow(
  graph: Pick<AnalysisResult, 'snapshotId' | 'analyzerVersion' | 'nodes' | 'edges'>,
  candidateId: string,
  options: FlowOptions = {}
): DiscoveredFlow | undefined {
  const view: FlowViewMode = options.view ?? 'control';
  const defaultLimits = view === 'data' ? { maxDepth: 5, maxFanOut: 6, maxSteps: 40 } : flowLimits;
  const limits = { ...defaultLimits, ...options };
  const candidate = findFlowCandidates(graph, Number.MAX_SAFE_INTEGER).find((item) => item.id === candidateId);
  if (!candidate) return undefined;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  for (const edges of outgoing.values()) edges.sort((a, b) => Number(a.evidence.attributes?.order ?? 0) - Number(b.evidence.attributes?.order ?? 0) || a.id.localeCompare(b.id));
  const steps: FlowStep[] = [];
  const relationships: FlowRelationship[] = [];
  const visited = new Set<string>();
  let truncated = false;

  const isEdgeAllowed = (type: GraphEdge['type']): boolean => {
    if (view === 'control') {
      return (
        type === 'ROUTE_HANDLER' ||
        type === 'MIDDLEWARE' ||
        type === 'DEPENDS_ON' ||
        type === 'HOOK' ||
        type === 'PLUGIN' ||
        type === 'MOUNTS' ||
        type === 'CALLS'
      );
    }
    if (view === 'data') {
      return (
        type === 'FLOWS_TO' ||
        type === 'RETURNS_TO' ||
        type === 'ROUTE_HANDLER' ||
        type === 'DEPENDS_ON'
      );
    }
    // view === 'all'
    return (
      type === 'ROUTE_HANDLER' ||
      type === 'MIDDLEWARE' ||
      type === 'DEPENDS_ON' ||
      type === 'HOOK' ||
      type === 'PLUGIN' ||
      type === 'MOUNTS' ||
      type === 'CALLS' ||
      type === 'FLOWS_TO' ||
      type === 'RETURNS_TO'
    );
  };

  const walk = (nodeId: string, depth: number, role: string, resolution: GraphEdge['resolution']) => {
    const node = nodeById.get(nodeId);
    if (!node || visited.has(nodeId)) return;
    if (steps.length >= limits.maxSteps || depth > limits.maxDepth) { truncated = true; return; }
    visited.add(nodeId);
    steps.push({ id: `${candidate.id}:step:${steps.length}`, nodeId, type: node.type, role, label: node.evidence?.name ?? node.key, resolution, evidence: node.evidence });
    const next = outgoing.get(nodeId) ?? [];
    for (const edge of next.slice(0, limits.maxFanOut)) {
      if (!isEdgeAllowed(edge.type)) continue;
      const target = nodeById.get(edge.to);
      relationships.push({ id: edge.id, from: nodeId, to: edge.to, type: edge.type, resolution: edge.resolution, evidence: edge.evidence });
      let nextRole = 'downstream';
      if (edge.type === 'ROUTE_HANDLER') nextRole = 'handler';
      else if (edge.type === 'MIDDLEWARE') nextRole = 'middleware';
      else if (edge.type === 'DEPENDS_ON') nextRole = 'dependency';
      else if (edge.type === 'HOOK') nextRole = 'hook';
      else if (edge.type === 'PLUGIN') nextRole = 'plugin';
      else if (edge.type === 'MOUNTS') nextRole = 'mount';
      else if (edge.type === 'FLOWS_TO') {
        const kind = String(target?.evidence?.attributes?.kind ?? '');
        if (kind === 'parameter') nextRole = 'parameter';
        else if (kind === 'variable') nextRole = 'variable';
        else if (kind === 'entrypoint_payload') nextRole = 'payload';
        else nextRole = 'data_flow';
      } else if (edge.type === 'RETURNS_TO') {
        nextRole = 'return_value';
      }

      if (target) {
        walk(edge.to, depth + 1, nextRole, edge.resolution);
      } else {
        // Even if target node object is missing from nodeById, record an unresolved step
        steps.push({
          id: `${candidate.id}:step:${steps.length}`,
          nodeId: edge.to,
          type: 'symbol',
          role: nextRole,
          label: edge.evidence?.name ?? edge.to,
          resolution: edge.resolution,
          evidence: edge.evidence,
        });
      }
    }
    if (next.length > limits.maxFanOut) truncated = true;
  };

  walk(candidate.nodeId, 0, 'entrypoint', 'observed');

  const limitations = [
    'Static CALLS edges do not prove runtime execution on every request.',
    'Dynamic registration, runtime reflection, and dynamic dispatch remain unresolved.',
    'Conditional middleware, decorators, or hooks may not execute on every request path.',
  ];
  if (view === 'data' || view === 'all') {
    limitations.push('Data-flow propagation does not perform heap-alias or whole-program points-to analysis.');
    limitations.push('Dynamic reflection, computed property accesses, and third-party library calls remain unresolved.');
  }

  return {
    id: candidate.id,
    snapshotId: graph.snapshotId,
    candidate,
    steps,
    relationships,
    truncated,
    limitations,
  };
}
