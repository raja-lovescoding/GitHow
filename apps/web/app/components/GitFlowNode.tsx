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

const defaultColor = { bg: '#ffffff', border: '#10b981', text: '#065f46', badge: '#059669' };
const typeColors: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  route: { bg: '#ffffff', border: '#3b82f6', text: '#1e40af', badge: '#2563eb' },
  symbol: defaultColor,
  file: { bg: '#ffffff', border: '#06b6d4', text: '#155e75', badge: '#0891b2' },
  module: { bg: '#ffffff', border: '#a855f7', text: '#6b21a8', badge: '#9333ea' },
  snapshot: { bg: '#ffffff', border: '#eab308', text: '#854d0e', badge: '#ca8a04' },
};

const methodBgColors: Record<string, string> = {
  GET: '#2563eb',
  POST: '#059669',
  PUT: '#d97706',
  PATCH: '#7c3aed',
  DELETE: '#dc2626',
};

function GitFlowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as RigNodeData;
  const isUnresolved = nodeData.resolution === 'unresolved';
  const color = isUnresolved
    ? { bg: '#fffdfa', border: '#ea580c', text: '#9a3412', badge: '#ea580c' }
    : (typeColors[nodeData.type] ?? defaultColor);

  const isSelected = selected || nodeData.isSelected;
  const methodBg = nodeData.method ? (methodBgColors[nodeData.method.toUpperCase()] ?? color.badge) : color.badge;

  return (
    <div
      className={`rig-graph-node ${isSelected ? 'selected' : ''} ${nodeData.isFlowStep ? 'flow-step' : ''} ${isUnresolved ? 'unresolved' : ''}`}
      style={{
        border: `1.5px ${isUnresolved ? 'dashed' : 'solid'} ${isSelected ? '#17231f' : color.border}`,
        backgroundColor: color.bg,
        boxShadow: isSelected
          ? '0 0 0 3px rgba(201, 242, 105, 0.55), 0 8px 18px rgba(23, 35, 31, 0.16)'
          : nodeData.isFlowStep
            ? '0 4px 12px rgba(16, 185, 129, 0.12)'
            : '0 2px 6px rgba(23, 35, 31, 0.05)',
      }}
    >
      <Handle type="target" position={Position.Left} className="rig-handle" />

      <div className="rig-node-header">
        <div className="rig-node-tags">
          {nodeData.stepNumber !== undefined ? (
            <span className="rig-step-badge">#{nodeData.stepNumber}</span>
          ) : null}
          {nodeData.method ? (
            <span className="rig-method-badge" style={{ backgroundColor: methodBg }}>
              {nodeData.method}
            </span>
          ) : (
            <span className="rig-type-badge" style={{ backgroundColor: color.badge }}>
              {nodeData.type}
            </span>
          )}
          {nodeData.role && nodeData.role !== 'downstream' ? (
            <span
              className="rig-role-badge"
              style={{
                backgroundColor:
                  nodeData.role === 'parameter'
                    ? '#0284c7'
                    : nodeData.role === 'return_value'
                      ? '#9333ea'
                      : nodeData.role === 'variable'
                        ? '#059669'
                        : nodeData.role === 'payload'
                          ? '#0284c7'
                          : undefined,
                color:
                  nodeData.role === 'parameter' ||
                  nodeData.role === 'return_value' ||
                  nodeData.role === 'variable' ||
                  nodeData.role === 'payload'
                    ? '#ffffff'
                    : undefined,
              }}
            >
              {nodeData.role === 'parameter'
                ? 'param'
                : nodeData.role === 'return_value'
                  ? 'return'
                  : nodeData.role === 'variable'
                    ? 'var'
                    : nodeData.role}
            </span>
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
            {nodeData.isExpanding ? 'Expanding…' : '+ Expand'}
          </button>
        </div>
      ) : null}

      <Handle type="source" position={Position.Right} className="rig-handle" />
    </div>
  );
}

export const GitFlowNode = memo(GitFlowNodeComponent);
