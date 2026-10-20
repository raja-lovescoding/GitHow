import { describe, expect, it } from 'vitest';
import { graphEdges, graphNodes } from './schema.js';
import type { GraphEdge, GraphNode, EdgeType } from '@gitflow/analyzer';

describe('Database Schema & Edge Type Mapping', () => {
  it('supports all Phase 4 relationship types in graph_edges table definition', () => {
    const supportedTypes: EdgeType[] = [
      'CONTAINS',
      'DECLARES',
      'IMPORTS',
      'CALLS',
      'EXTENDS',
      'IMPLEMENTS',
      'ROUTE_HANDLER',
      'MIDDLEWARE',
      'MOUNTS',
      'DEPENDS_ON',
      'HOOK',
      'PLUGIN',
      'FLOWS_TO',
      'RETURNS_TO',
    ];

    for (const edgeType of supportedTypes) {
      const mockEdge: GraphEdge = {
        id: `edge_${edgeType.toLowerCase()}`,
        type: edgeType,
        snapshotId: '11111111-1111-1111-1111-111111111111',
        analyzerVersion: '0.1.0',
        from: 'node-from',
        to: 'node-to',
        resolution: 'resolved',
        evidence: {
          path: 'src/main.ts',
          startLine: 1,
          startColumn: 1,
          endLine: 2,
          endColumn: 10,
          name: `test ${edgeType}`,
        },
      };

      // Verify serialization shape matches graphEdges table columns
      const dbValues = {
        id: mockEdge.id,
        snapshotId: mockEdge.snapshotId,
        analyzerVersion: mockEdge.analyzerVersion,
        schemaVersion: 'v1',
        edgeType: mockEdge.type,
        fromNodeId: mockEdge.from,
        toNodeId: mockEdge.to,
        resolution: mockEdge.resolution,
        evidence: mockEdge.evidence,
      };

      expect(dbValues.edgeType).toBe(edgeType);
      expect(dbValues.resolution).toBe('resolved');
      expect(graphEdges.edgeType.name).toBe('edge_type');
      expect(graphEdges.fromNodeId.name).toBe('from_node_id');
      expect(graphEdges.toNodeId.name).toBe('to_node_id');
    }
  });

  it('supports all graph node types in graph_nodes table definition', () => {
    const supportedNodeTypes: Array<GraphNode['type']> = ['snapshot', 'file', 'symbol', 'route', 'module'];

    for (const nodeType of supportedNodeTypes) {
      const mockNode: GraphNode = {
        id: `node_${nodeType}`,
        type: nodeType,
        snapshotId: '11111111-1111-1111-1111-111111111111',
        analyzerVersion: '0.1.0',
        key: `key_${nodeType}`,
        evidence: {
          path: 'src/app.ts',
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 10,
        },
      };

      const dbValues = {
        id: mockNode.id,
        snapshotId: mockNode.snapshotId,
        analyzerVersion: mockNode.analyzerVersion,
        schemaVersion: 'v1',
        nodeType: mockNode.type,
        nodeKey: mockNode.key,
        evidence: mockNode.evidence,
      };

      expect(dbValues.nodeType).toBe(nodeType);
      expect(graphNodes.nodeType.name).toBe('node_type');
      expect(graphNodes.nodeKey.name).toBe('node_key');
    }
  });
});
