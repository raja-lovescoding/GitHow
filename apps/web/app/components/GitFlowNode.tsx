'use client';

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface RigNodeData {
  id: string;
  type: string;
  label: string;
  subLabel?: string;
  method?: string;
  role?: string;
  stepNumber?: number;
  resolution?: string;
  isFlowStep?: boolean;
  isSelected?: boolean;
  onExpand?: (nodeId: string) => void;
  canExpand?: boolean;
  isExpanding?: boolean;
}

const defaultColor = { bg: '#f0fdf4', border: '#10b981', text: '#065f46', badge: '#059669' };
const typeColors: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  route: { bg: '#eff6ff', border: '#3b82f6', text: '#1e40af', badge: '#2563eb' },
  symbol: defaultColor,
  file: { bg: '#f0fdfa', border: '#06b6d4', text: '#155e75', badge: '#0891b2' },
  module: { bg: '#fdf4ff', border: '#a855f7', text: '#6b21a8', badge: '#9333ea' },
  snapshot: { bg: '#fefce8', border: '#eab308', text: '#854d0e', badge: '#ca8a04' },
};

function GitFlowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as RigNodeData;
  const isUnresolved = nodeData.resolution === 'unresolved';
  const color = isUnresolved
    ? { bg: '#fff7ed', border: '#f97316', text: '#9a3412', badge: '#ea580c' }
    : (typeColors[nodeData.type] ?? defaultColor);

  const isSelected = selected || nodeData.isSelected;

  return (
    <div
      className={`rig-graph-node ${isSelected ? 'selected' : ''} ${nodeData.isFlowStep ? 'flow-step' : ''} ${isUnresolved ? 'unresolved' : ''}`}
      style={{
        border: `2px ${isUnresolved ? 'dashed' : 'solid'} ${isSelected ? '#17231f' : color.border}`,
        backgroundColor: color.bg,
        boxShadow: isSelected
          ? '0 0 0 3px rgba(201, 242, 105, 0.6), 0 8px 16px rgba(23, 35, 31, 0.15)'
          : nodeData.isFlowStep
            ? '0 4px 12px rgba(16, 185, 129, 0.12)'
            : '0 2px 6px rgba(23, 35, 31, 0.06)',
      }}
    >
      <Handle type="target" position={Position.Left} className="rig-handle" />

      <div className="rig-node-header">
        <div className="rig-node-tags">
          {nodeData.stepNumber !== undefined ? (
            <span className="rig-step-badge">#{nodeData.stepNumber}</span>
          ) : null}
          {nodeData.method ? (
            <span className="rig-method-badge" style={{ backgroundColor: color.badge }}>
              {nodeData.method}
            </span>
          ) : (
            <span className="rig-type-badge" style={{ backgroundColor: color.badge }}>
              {nodeData.type}
            </span>
          )}
          {nodeData.role && nodeData.role !== 'downstream' ? (
            <span className="rig-role-badge">{nodeData.role}</span>
          ) : null}
          {isUnresolved ? (
            <span className="rig-unresolved-badge">⚠ unresolved</span>
          ) : null}
        </div>
      </div>

      <div className="rig-node-body">
        <strong className="rig-node-title" title={nodeData.label}>
          {nodeData.label}
        </strong>
        {nodeData.subLabel ? (
          <span className="rig-node-sub" title={nodeData.subLabel}>
            {nodeData.subLabel}
          </span>
        ) : null}
      </div>

      {nodeData.canExpand && nodeData.onExpand ? (
        <div className="rig-node-actions">
          <button
            type="button"
            className="rig-expand-btn"
            disabled={nodeData.isExpanding}
            onClick={(e) => {
              e.stopPropagation();
              nodeData.onExpand?.(nodeData.id);
            }}
            title="Expand connections in RIG"
          >
            {nodeData.isExpanding ? '…' : '+ Expand'}
          </button>
        </div>
      ) : null}

      <Handle type="source" position={Position.Right} className="rig-handle" />
    </div>
  );
}

export const GitFlowNode = memo(GitFlowNodeComponent);
