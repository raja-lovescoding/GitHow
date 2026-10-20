'use client';

import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { GitFlowNode, type RigNodeData } from './GitFlowNode';

export type GraphNodeType = {
  id: string;
  type: string;
  key: string;
  evidence: {
    path?: string;
    name?: string;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
    attributes?: Record<string, string | number | boolean>;
  } | null;
};

export type GraphEdgeType = {
  id: string;
  type: string;
  from: string;
  to: string;
  resolution: string;
  evidence: {
    path?: string;
    name?: string;
    startLine?: number;
    startColumn?: number;
    attributes?: Record<string, string | number | boolean>;
  } | null;
};

export type FlowCandidateType = {
  id: string;
  method: string;
  path: string;
  nodeId: string;
  evidence?: GraphNodeType['evidence'];
};

export type FlowStepType = {
  id: string;
  nodeId: string;
  type: string;
  role: string;
  label: string;
  resolution: string;
  evidence?: GraphNodeType['evidence'];
};

export type FlowRelationshipType = {
  id: string;
  from: string;
  to: string;
  type: string;
  resolution: string;
  evidence?: GraphNodeType['evidence'];
};

export type FlowType = {
  id: string;
  candidate: FlowCandidateType;
  steps: FlowStepType[];
  relationships?: FlowRelationshipType[];
  truncated: boolean;
  limitations: string[];
};

export interface GitFlowGraphProps {
  nodes: GraphNodeType[];
  edges: GraphEdgeType[];
  flow: FlowType | null;
  selectedNodeId: string | null;
  selectedEdgeId?: string | null;
  onSelectNode: (nodeId: string, filePath?: string | null) => void;
  onSelectEdge?: (edgeId: string | null) => void;
  onExpandNode?: (nodeId: string) => void;
  isExpanding?: boolean;
  viewMode: 'flow' | 'full';
  onViewModeChange: (mode: 'flow' | 'full') => void;
  flowView?: 'control' | 'data' | 'all';
  onFlowViewChange?: (view: 'control' | 'data' | 'all') => void;
  fitViewTrigger?: number;
}

const nodeTypes = {
  rigNode: GitFlowNode,
};

function computeDagrePositions(
  nodes: GraphNodeType[],
  edges: GraphEdgeType[],
  direction = 'LR'
): Map<string, { x: number; y: number }> {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 50, ranksep: 130 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 250, height: 86 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.from, edge.to);
  });

  dagre.layout(dagreGraph);

  const posMap = new Map<string, { x: number; y: number }>();
  nodes.forEach((node) => {
    const pos = dagreGraph.node(node.id);
    posMap.set(node.id, {
      x: pos ? pos.x - 125 : 0,
      y: pos ? pos.y - 43 : 0,
    });
  });

  return posMap;
}

function InnerGraph({
  nodes: inputNodes,
  edges: inputEdges,
  flow,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onExpandNode,
  isExpanding,
  viewMode,
  fitViewTrigger,
}: GitFlowGraphProps) {
  const { fitView } = useReactFlow();
  const prevCountRef = useRef<number>(0);

  // 1. Determine active visible nodes & edges based on viewMode
  const { displayNodes, displayEdges } = useMemo(() => {
    if (viewMode === 'flow' && flow && flow.steps.length > 0) {
      const stepNodeIds = new Set(flow.steps.map((s) => s.nodeId));
      const nodesInFlow: GraphNodeType[] = [];
      const seenNodes = new Set<string>();

      for (const step of flow.steps) {
        if (seenNodes.has(step.nodeId)) continue;
        seenNodes.add(step.nodeId);
        const fromInput = inputNodes.find((n) => n.id === step.nodeId);
        if (fromInput) {
          nodesInFlow.push(fromInput);
        } else {
          nodesInFlow.push({
            id: step.nodeId,
            type: step.type,
            key: step.label,
            evidence: step.evidence ?? null,
          });
        }
      }

      // Collect flow relationships and broader graph edges between flow steps
      // with deduplication both by ID and by from->to:type pair
      const flowEdges: GraphEdgeType[] = [];
      const seenEdgeIds = new Set<string>();
      const seenPairKeys = new Set<string>();

      for (const rel of flow.relationships ?? []) {
        const pairKey = `${rel.from}->${rel.to}:${rel.type}`;
        if (!seenEdgeIds.has(rel.id) && !seenPairKeys.has(pairKey)) {
          seenEdgeIds.add(rel.id);
          seenPairKeys.add(pairKey);
          flowEdges.push({
            id: rel.id,
            type: rel.type,
            from: rel.from,
            to: rel.to,
            resolution: rel.resolution,
            evidence: rel.evidence ?? null,
          });
        }
      }

      for (const edge of inputEdges) {
        const pairKey = `${edge.from}->${edge.to}:${edge.type}`;
        if (stepNodeIds.has(edge.from) && stepNodeIds.has(edge.to) && !seenEdgeIds.has(edge.id) && !seenPairKeys.has(pairKey)) {
          seenEdgeIds.add(edge.id);
          seenPairKeys.add(pairKey);
          flowEdges.push(edge);
        }
      }

      return { displayNodes: nodesInFlow, displayEdges: flowEdges };
    }

    return { displayNodes: inputNodes, displayEdges: inputEdges };
  }, [viewMode, flow, inputNodes, inputEdges]);

  // 2. Compute stable positions using dagre ONLY when graph topology changes
  const topologyKey = useMemo(() => {
    const nodeIds = displayNodes.map((n) => n.id).join(',');
    const edgeIds = displayEdges.map((e) => `${e.from}->${e.to}`).join(',');
    return `${viewMode}:${nodeIds}|${edgeIds}`;
  }, [viewMode, displayNodes, displayEdges]);

  const basePositions = useMemo(() => {
    return computeDagrePositions(displayNodes, displayEdges, 'LR');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey]);

  // 3. Map flow step data
  const flowStepMap = useMemo(() => {
    if (!flow) return new Map<string, { role: string; index: number; resolution: string }>();
    return new Map(flow.steps.map((s, idx) => [s.nodeId, { role: s.role, index: idx + 1, resolution: s.resolution }]));
  }, [flow]);

  // 4. Convert to React Flow nodes with selection and action bindings
  const rfNodes = useMemo<Node[]>(() => {
    return displayNodes.map((n) => {
      const stepInfo = flowStepMap.get(n.id);
      const isSelected = n.id === selectedNodeId;
      const isFlowStep = Boolean(stepInfo);

      let method: string | undefined;
      let label = n.evidence?.name ?? n.key;
      if (n.type === 'route') {
        method = String(n.evidence?.attributes?.method ?? 'ROUTE');
        label = String(n.evidence?.attributes?.path ?? label);
      }

      const subLabel = n.evidence?.path
        ? `${n.evidence.path}${n.evidence.startLine ? `:${n.evidence.startLine}` : ''}`
        : undefined;

      const data: RigNodeData = {
        id: n.id,
        type: n.type,
        label,
        subLabel,
        method,
        role: stepInfo?.role,
        stepNumber: stepInfo?.index,
        resolution: stepInfo?.resolution ?? (n.key.startsWith('unresolved') ? 'unresolved' : 'observed'),
        isFlowStep,
        isSelected,
        canExpand: Boolean(onExpandNode),
        isExpanding: isExpanding && isSelected,
        onExpand: onExpandNode,
      };

      const pos = basePositions.get(n.id) ?? { x: 0, y: 0 };

      return {
        id: n.id,
        type: 'rigNode',
        data: data as unknown as Record<string, unknown>,
        position: pos,
        selected: isSelected,
      };
    });
  }, [displayNodes, basePositions, flowStepMap, selectedNodeId, onExpandNode, isExpanding]);

  // 5. Convert to React Flow edges with distinct styling and edge selection
  const flowEdgeIdSet = useMemo(() => {
    if (!flow || !flow.relationships) return new Set<string>();
    return new Set(flow.relationships.map((r) => r.id));
  }, [flow]);

  const rfEdges = useMemo<Edge[]>(() => {
    return displayEdges.map((e) => {
      const isPartOfFlow = flowEdgeIdSet.has(e.id);
      const isUnresolved = e.resolution === 'unresolved';
      const isConnectedToSelected = selectedNodeId === e.from || selectedNodeId === e.to;
      const isEdgeSelected = e.id === selectedEdgeId;

      let strokeColor = '#94a3b8';
      let strokeWidth = 1.6;

      if (isUnresolved) {
        strokeColor = '#ea580c';
      } else if (e.type === 'FLOWS_TO') {
        strokeColor = '#0284c7';
        strokeWidth = 2.4;
      } else if (e.type === 'RETURNS_TO') {
        strokeColor = '#9333ea';
        strokeWidth = 2.4;
      } else if (e.type === 'ROUTE_HANDLER') {
        strokeColor = '#2563eb';
        strokeWidth = 2.0;
      } else if (e.type === 'CALLS') {
        strokeColor = '#0f766e';
        strokeWidth = 1.8;
      } else if (isPartOfFlow) {
        strokeColor = '#10b981';
        strokeWidth = 2.4;
      } else if (isConnectedToSelected) {
        strokeColor = '#3b82f6';
        strokeWidth = 2.2;
      }

      if (isEdgeSelected) {
        strokeColor = '#d97706';
        strokeWidth = 3.5;
      }

      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'default',
        label: e.type,
        labelStyle: {
          fill: isEdgeSelected ? '#17231f' : strokeColor,
          fontWeight: isEdgeSelected ? 700 : 600,
          fontSize: 10,
          fontFamily: 'DM Mono, monospace',
        },
        labelBgStyle: {
          fill: isEdgeSelected ? '#fef08a' : '#ffffff',
          fillOpacity: 0.95,
          rx: 4,
          ry: 4,
        },
        labelBgPadding: [6, 3] as [number, number],
        animated: isPartOfFlow,
        selected: isEdgeSelected,
        style: {
          stroke: strokeColor,
          strokeWidth,
          strokeDasharray: isUnresolved ? '6,4' : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 16,
          height: 16,
        },
      };
    });
  }, [displayEdges, flowEdgeIdSet, selectedNodeId, selectedEdgeId]);

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);

  // Synchronize rfNodes while preserving user drag positions
  useEffect(() => {
    setNodes((prevNodes) => {
      const prevPosMap = new Map(prevNodes.map((n) => [n.id, n.position]));
      return rfNodes.map((n) => {
        const userPos = prevPosMap.get(n.id);
        return {
          ...n,
          position: userPos && (userPos.x !== 0 || userPos.y !== 0) ? userPos : n.position,
        };
      });
    });
  }, [rfNodes, setNodes]);

  useEffect(() => {
    setEdges(rfEdges);
  }, [rfEdges, setEdges]);

  // Fit view ONLY when viewMode changes, flow ID changes, fitViewTrigger changes,
  // or when initial nodes transition from 0 to >0.
  useEffect(() => {
    const isInitialLoad = prevCountRef.current === 0 && displayNodes.length > 0;
    prevCountRef.current = displayNodes.length;

    const timer = setTimeout(() => {
      fitView({ padding: 0.22, duration: 350 });
    }, 120);
    return () => clearTimeout(timer);
  }, [viewMode, flow?.id, fitViewTrigger, fitView, displayNodes.length]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const rigNode = displayNodes.find((n) => n.id === node.id);
      onSelectNode(node.id, rigNode?.evidence?.path ?? null);
      if (onSelectEdge) onSelectEdge(null);
    },
    [displayNodes, onSelectNode, onSelectEdge]
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      if (onSelectEdge) onSelectEdge(edge.id);
    },
    [onSelectEdge]
  );

  const handlePaneClick = useCallback(() => {
    onSelectNode('', null);
    if (onSelectEdge) onSelectEdge(null);
  }, [onSelectNode, onSelectEdge]);

  return (
    <div className="rig-graph-viewport">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        minZoom={0.12}
        maxZoom={2.8}
      >
        <Background color="#cbd5e1" gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          nodeColor={(node) => {
            const data = node.data as unknown as RigNodeData;
            if (data.type === 'route') return '#3b82f6';
            if (data.type === 'symbol') return '#10b981';
            if (data.type === 'file') return '#06b6d4';
            return '#cbd5e1';
          }}
          maskColor="rgba(244, 241, 233, 0.75)"
          className="rig-minimap"
        />

        {nodes.length === 0 ? (
          <div className="rig-graph-empty-overlay">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
            <p>No nodes available to render in this view.</p>
          </div>
        ) : null}
      </ReactFlow>
    </div>
  );
}

export function GitFlowGraph(props: GitFlowGraphProps) {
  return (
    <ReactFlowProvider>
      <InnerGraph {...props} />
    </ReactFlowProvider>
  );
}
