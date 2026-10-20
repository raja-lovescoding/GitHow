'use client';

import React, { useMemo, useCallback, useEffect } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  Panel,
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
  onSelectNode: (nodeId: string, filePath?: string | null) => void;
  onExpandNode?: (nodeId: string) => void;
  isExpanding?: boolean;
  viewMode: 'flow' | 'full';
  onViewModeChange: (mode: 'flow' | 'full') => void;
}

const nodeTypes = {
  rigNode: GitFlowNode,
};

function layoutDagre(rawNodes: Node[], rawEdges: Edge[], direction = 'LR') {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 40, ranksep: 120 });

  rawNodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 240, height: 75 });
  });

  rawEdges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = rawNodes.map((node) => {
    const pos = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: pos ? pos.x - 120 : 0,
        y: pos ? pos.y - 37 : 0,
      },
    };
  });

  return { nodes: layoutedNodes, edges: rawEdges };
}

function InnerGraph({
  nodes: inputNodes,
  edges: inputEdges,
  flow,
  selectedNodeId,
  onSelectNode,
  onExpandNode,
  isExpanding,
  viewMode,
  onViewModeChange,
}: GitFlowGraphProps) {
  const { fitView } = useReactFlow();

  // Determine active visible subset based on viewMode
  const { displayNodes, displayEdges } = useMemo(() => {
    if (viewMode === 'flow' && flow && flow.steps.length > 0) {
      const stepNodeIds = new Set(flow.steps.map((s) => s.nodeId));
      const stepMap = new Map(flow.steps.map((s, idx) => [s.nodeId, { step: s, index: idx + 1 }]));

      // Gather all input nodes matching stepNodeIds
      const nodesInFlow: GraphNodeType[] = [];
      const seen = new Set<string>();

      for (const step of flow.steps) {
        if (seen.has(step.nodeId)) continue;
        seen.add(step.nodeId);
        const fromInput = inputNodes.find((n) => n.id === step.nodeId);
        if (fromInput) {
          nodesInFlow.push(fromInput);
        } else {
          // Construct fallback from step evidence
          nodesInFlow.push({
            id: step.nodeId,
            type: step.type,
            key: step.label,
            evidence: step.evidence ?? null,
          });
        }
      }

      // Collect flow relationships or edges between flow steps
      const flowEdges: GraphEdgeType[] = [];
      const seenEdge = new Set<string>();

      for (const rel of flow.relationships ?? []) {
        if (!seenEdge.has(rel.id)) {
          seenEdge.add(rel.id);
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

      // Also include any direct edges between flow nodes from the broader graph
      for (const edge of inputEdges) {
        if (stepNodeIds.has(edge.from) && stepNodeIds.has(edge.to) && !seenEdge.has(edge.id)) {
          seenEdge.add(edge.id);
          flowEdges.push(edge);
        }
      }

      return { displayNodes: nodesInFlow, displayEdges: flowEdges };
    }

    return { displayNodes: inputNodes, displayEdges: inputEdges };
  }, [viewMode, flow, inputNodes, inputEdges]);

  // Convert to React Flow nodes
  const flowStepMap = useMemo(() => {
    if (!flow) return new Map<string, { role: string; index: number; resolution: string }>();
    return new Map(flow.steps.map((s, idx) => [s.nodeId, { role: s.role, index: idx + 1, resolution: s.resolution }]));
  }, [flow]);

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

      return {
        id: n.id,
        type: 'rigNode',
        data: data as unknown as Record<string, unknown>,
        position: { x: 0, y: 0 },
        selected: isSelected,
      };
    });
  }, [displayNodes, flowStepMap, selectedNodeId, onExpandNode, isExpanding]);

  // Convert to React Flow edges
  const flowEdgeIdSet = useMemo(() => {
    if (!flow || !flow.relationships) return new Set<string>();
    return new Set(flow.relationships.map((r) => r.id));
  }, [flow]);

  const rfEdges = useMemo<Edge[]>(() => {
    return displayEdges.map((e) => {
      const isPartOfFlow = flowEdgeIdSet.has(e.id);
      const isUnresolved = e.resolution === 'unresolved';
      const isConnectedToSelected = selectedNodeId === e.from || selectedNodeId === e.to;

      let strokeColor = '#94a3b8';
      let strokeWidth = 1.5;

      if (isPartOfFlow) {
        strokeColor = '#10b981';
        strokeWidth = 2.5;
      } else if (isConnectedToSelected) {
        strokeColor = '#3b82f6';
        strokeWidth = 2;
      } else if (isUnresolved) {
        strokeColor = '#f59e0b';
      }

      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'default',
        label: e.type,
        labelStyle: { fill: strokeColor, fontWeight: 600, fontSize: 10, fontFamily: 'DM Mono, monospace' },
        labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9, rx: 4, ry: 4 },
        animated: isPartOfFlow,
        style: {
          stroke: strokeColor,
          strokeWidth,
          strokeDasharray: isUnresolved ? '5,5' : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 16,
          height: 16,
        },
      };
    });
  }, [displayEdges, flowEdgeIdSet, selectedNodeId]);

  // Apply dagre layout
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(() => {
    return layoutDagre(rfNodes, rfEdges, 'LR');
  }, [rfNodes, rfEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  useEffect(() => {
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges]);

  // Auto-fit on layout or flow change
  useEffect(() => {
    const timer = setTimeout(() => {
      fitView({ padding: 0.2, duration: 400 });
    }, 100);
    return () => clearTimeout(timer);
  }, [viewMode, flow?.id, fitView]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const rigNode = displayNodes.find((n) => n.id === node.id);
      onSelectNode(node.id, rigNode?.evidence?.path ?? null);
    },
    [displayNodes, onSelectNode]
  );

  return (
    <div className="rig-graph-viewport">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.15}
        maxZoom={2.5}
      >
        <Background color="#cbd5e1" gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(node) => {
            const data = node.data as unknown as RigNodeData;
            if (data.type === 'route') return '#3b82f6';
            if (data.type === 'symbol') return '#10b981';
            if (data.type === 'file') return '#06b6d4';
            return '#cbd5e1';
          }}
          maskColor="rgba(244, 241, 233, 0.7)"
          className="rig-minimap"
        />

        <Panel position="top-right" className="rig-graph-panel">
          <div className="rig-mode-toggles">
            <button
              type="button"
              className={`mode-btn ${viewMode === 'flow' ? 'active' : ''}`}
              onClick={() => onViewModeChange('flow')}
              disabled={!flow}
              title={flow ? 'Focus on active GitFlow route and sequence' : 'Select a flow to focus'}
            >
              Flow View {flow ? `(${flow.steps.length})` : ''}
            </button>
            <button
              type="button"
              className={`mode-btn ${viewMode === 'full' ? 'active' : ''}`}
              onClick={() => onViewModeChange('full')}
              title="Show full repository graph with flow highlighted"
            >
              Full Graph ({inputNodes.length})
            </button>
            <button
              type="button"
              className="mode-btn ghost"
              onClick={() => fitView({ padding: 0.2, duration: 300 })}
              title="Fit graph to view"
            >
              Fit View
            </button>
          </div>
        </Panel>

        {nodes.length === 0 ? (
          <div className="rig-graph-empty-overlay">
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
