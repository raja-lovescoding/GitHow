'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import {
  GitFlowGraph,
  type GraphNodeType,
  type GraphEdgeType,
  type FlowCandidateType,
  type FlowType,
  type FlowRelationshipType,
} from '../../components/GitFlowGraph';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const PRODUCT_NAME = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'GitHow';

type ManifestEntry = { path: string; size: number; language: string | null; classification: string };
type RepositoryInfo = { identity: { owner: string; name: string }; defaultBranch: string; sha: string };
type JobInfo = { id: string; status: string; stage: string; progress: number };
type AnalysisInfo = { status: string; progress: number; diagnostics: { path: string; message: string; startLine?: number; startColumn?: number }[] };
type SourceResponse = { path: string; content: string; language: string | null; bytes: number; lineCount: number };
type State = {
  repository?: RepositoryInfo;
  snapshot?: { id: string; status: string; manifest: ManifestEntry[] };
  job?: JobInfo;
  analysis?: AnalysisInfo;
  graph?: { nodes: GraphNodeType[]; edges: GraphEdgeType[] };
};

export default function RepositoryPage() {
  const params = useParams<{ owner: string; repo: string }>();
  const [state, setState] = useState<State>({});
  const [error, setError] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [source, setSource] = useState<SourceResponse | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [flowCandidates, setFlowCandidates] = useState<FlowCandidateType[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowType | null>(null);
  const [viewMode, setViewMode] = useState<'flow' | 'full'>('flow');

  // Progressive neighborhood expansion state
  const [expandedNodes, setExpandedNodes] = useState<Map<string, GraphNodeType>>(new Map());
  const [expandedEdges, setExpandedEdges] = useState<Map<string, GraphEdgeType>>(new Map());
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);

  const repoIdentity = useMemo(() => ({ owner: params.owner ?? '', repo: params.repo ?? '' }), [params.owner, params.repo]);

  // Initial repository submission / resolution
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`${API}/repos`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `https://github.com/${repoIdentity.owner}/${repoIdentity.repo}` }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? 'The repository could not be loaded.');
        if (active) {
          setState((current) => ({
            ...current,
            repository: data.repository,
            snapshot: data.snapshot,
            job: data.job,
            analysis: data.analysis,
            graph: data.graph,
          }));
        }
      } catch (requestError) {
        if (active) setError((requestError as Error).message);
      }
    }
    void load();
    return () => { active = false; };
  }, [repoIdentity.owner, repoIdentity.repo]);

  // Poll ingestion job until completion
  useEffect(() => {
    if (!state.job?.id || state.job.status === 'completed' || state.job.status === 'failed') return;
    const jobId = state.job.id;
    const timer = window.setInterval(async () => {
      const response = await fetch(`${API}/jobs/${jobId}`);
      if (!response.ok) return;
      const job = await response.json();
      setState((current) => ({ ...current, job }));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [state.job?.id, state.job?.status]);

  // Poll analysis run until completion
  useEffect(() => {
    if (!state.snapshot?.id || state.analysis?.status === 'completed' || state.analysis?.status === 'partial' || state.analysis?.status === 'failed') return;
    const snapshotId = state.snapshot.id;
    const timer = window.setInterval(async () => {
      const response = await fetch(`${API}/snapshots/${snapshotId}/analysis`);
      if (!response.ok) return;
      const analysis = await response.json();
      setState((current) => ({ ...current, analysis }));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [state.snapshot?.id, state.analysis?.status]);

  // Fetch initial bounded graph when analysis is ready
  useEffect(() => {
    if (!state.snapshot?.id || !state.analysis || (state.analysis.status !== 'completed' && state.analysis.status !== 'partial') || state.graph) return;
    const snapshotId = state.snapshot.id;
    void fetch(`${API}/snapshots/${snapshotId}/graph?limit=500`)
      .then(async (response) => {
        if (!response.ok) return;
        const graph = await response.json();
        setState((current) => ({ ...current, graph }));
      })
      .catch(() => undefined);
  }, [state.snapshot?.id, state.analysis?.status, state.graph]);

  // Fetch flow candidates when analysis is ready
  useEffect(() => {
    if (!state.snapshot?.id || !state.analysis || (state.analysis.status !== 'completed' && state.analysis.status !== 'partial')) return;
    const snapshotId = state.snapshot.id;
    setFlowCandidates([]);
    setSelectedFlowId(null);
    setFlow(null);
    void fetch(`${API}/snapshots/${snapshotId}/flows?limit=100`)
      .then(async (response) => response.ok ? response.json() : { candidates: [] })
      .then((data: { candidates?: FlowCandidateType[] }) => {
        const candidates = data.candidates ?? [];
        setFlowCandidates(candidates);
        if (candidates[0]) {
          setSelectedFlowId(candidates[0].id);
          setViewMode('flow');
        }
      })
      .catch(() => setFlowCandidates([]));
  }, [state.snapshot?.id, state.analysis?.status]);

  // Fetch specific flow sequence when selectedFlowId changes
  useEffect(() => {
    if (!state.snapshot?.id || !selectedFlowId) return;
    void fetch(`${API}/snapshots/${state.snapshot.id}/flows/${selectedFlowId}`)
      .then(async (response) => response.ok ? response.json() : null)
      .then((data: FlowType | null) => {
        setFlow(data);
        if (data && data.steps.length > 0) {
          const firstStep = data.steps[0];
          if (firstStep) {
            setSelectedNodeId(firstStep.nodeId);
            if (firstStep.evidence?.path) setSelectedPath(firstStep.evidence.path);
          }
        }
      })
      .catch(() => setFlow(null));
  }, [state.snapshot?.id, selectedFlowId]);

  // Progressive graph neighborhood expansion
  const handleExpandNode = useCallback(async (nodeId: string) => {
    if (!state.snapshot?.id) return;
    setIsExpanding(true);
    setExpandError(null);
    try {
      const response = await fetch(`${API}/snapshots/${state.snapshot.id}/nodes/${encodeURIComponent(nodeId)}/neighborhood?limit=50`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.message ?? 'Failed to expand node connections.');
      }
      const data = await response.json();
      if (data.nodes && Array.isArray(data.nodes)) {
        setExpandedNodes((prev) => {
          const next = new Map(prev);
          for (const n of data.nodes) next.set(n.id, n);
          return next;
        });
      }
      if (data.edges && Array.isArray(data.edges)) {
        setExpandedEdges((prev) => {
          const next = new Map(prev);
          for (const e of data.edges) next.set(e.id, e);
          return next;
        });
      }
    } catch (err) {
      setExpandError((err as Error).message);
    } finally {
      setIsExpanding(false);
    }
  }, [state.snapshot?.id]);

  // Combine persisted graph nodes with expanded nodes and flow steps
  const combinedNodes = useMemo(() => {
    const base = state.graph?.nodes ?? [];
    const map = new Map<string, GraphNodeType>();
    for (const n of base) map.set(n.id, n);
    for (const [id, n] of expandedNodes) map.set(id, n);
    if (flow) {
      for (const step of flow.steps) {
        if (!map.has(step.nodeId)) {
          map.set(step.nodeId, {
            id: step.nodeId,
            type: step.type,
            key: step.label,
            evidence: step.evidence ?? null,
          });
        }
      }
    }
    return [...map.values()];
  }, [state.graph?.nodes, expandedNodes, flow]);

  // Combine persisted graph edges with expanded edges and flow relationships
  const combinedEdges = useMemo(() => {
    const base = state.graph?.edges ?? [];
    const map = new Map<string, GraphEdgeType>();
    for (const e of base) map.set(e.id, e);
    for (const [id, e] of expandedEdges) map.set(id, e);
    if (flow?.relationships) {
      for (const rel of flow.relationships) {
        if (!map.has(rel.id)) {
          map.set(rel.id, {
            id: rel.id,
            type: rel.type,
            from: rel.from,
            to: rel.to,
            resolution: rel.resolution,
            evidence: rel.evidence ?? null,
          });
        }
      }
    }
    return [...map.values()];
  }, [state.graph?.edges, expandedEdges, flow]);

  const graphNodeById = useMemo(() => new Map(combinedNodes.map((node) => [node.id, node])), [combinedNodes]);

  const manifestEntries = state.snapshot?.manifest ?? [];

  // Search filter
  const visibleNodes = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return combinedNodes;
    return combinedNodes.filter((node) => {
      const haystack = [node.evidence?.name, node.key, node.evidence?.path, node.type].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [combinedNodes, searchTerm]);

  // Initial file selection fallback
  useEffect(() => {
    const firstManifestEntry = manifestEntries[0];
    if (!selectedPath && firstManifestEntry) {
      setSelectedPath(firstManifestEntry.path);
      return;
    }
    if (selectedPath && manifestEntries.length > 0 && !manifestEntries.some((entry) => entry.path === selectedPath)) {
      setSelectedPath(firstManifestEntry?.path ?? null);
    }
  }, [manifestEntries, selectedPath]);

  // Fetch source content for selectedPath
  useEffect(() => {
    const fallbackPath = selectedPath ?? combinedNodes.find((node) => node.evidence?.path)?.evidence?.path ?? null;
    if (!state.snapshot?.id || !fallbackPath) return;
    setSourceLoading(true);
    let isCancelled = false;
    fetch(`${API}/snapshots/${state.snapshot.id}/source?path=${encodeURIComponent(fallbackPath)}`)
      .then(async (response) => {
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          if (!isCancelled) {
            setSource({ path: fallbackPath, content: detail.message ?? 'Unable to load source for this file.', language: null, bytes: 0, lineCount: 1 });
            setSourceLoading(false);
          }
          return;
        }
        const nextSource = await response.json();
        if (!isCancelled) {
          setSource(nextSource);
          setSelectedPath(fallbackPath);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setSource({ path: fallbackPath, content: 'Unable to load source for this file.', language: null, bytes: 0, lineCount: 1 });
        }
      })
      .finally(() => {
        if (!isCancelled) setSourceLoading(false);
      });
    return () => { isCancelled = true; };
  }, [state.snapshot?.id, selectedPath, combinedNodes]);

  // Active selected node
  const selectedNode = useMemo(() => {
    if (selectedNodeId) {
      const fromGraph = graphNodeById.get(selectedNodeId);
      if (fromGraph) return fromGraph;
      const step = flow?.steps.find((s) => s.nodeId === selectedNodeId);
      if (step) return { id: step.nodeId, type: step.type, key: step.label, evidence: step.evidence ?? null };
    }
    if (selectedPath) return combinedNodes.find((node) => node.evidence?.path === selectedPath) ?? null;
    return null;
  }, [graphNodeById, combinedNodes, selectedNodeId, selectedPath, flow]);

  // Direct incoming and outgoing relationships
  const relatedEdges = useMemo<Array<GraphEdgeType | FlowRelationshipType>>(() => {
    if (!selectedNode) return [];
    return combinedEdges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id);
  }, [combinedEdges, selectedNode]);

  const inboundCalls = useMemo(() => {
    if (!selectedNode) return [];
    return combinedEdges
      .filter((edge) => edge.type === 'CALLS' && edge.to === selectedNode.id)
      .map((edge) => ({ edge, node: graphNodeById.get(edge.from) ?? null }))
      .filter((item) => item.node);
  }, [combinedEdges, graphNodeById, selectedNode]);

  const outboundCalls = useMemo(() => {
    if (!selectedNode) return [];
    return combinedEdges
      .filter((edge) => edge.type === 'CALLS' && edge.from === selectedNode.id)
      .map((edge) => ({ edge, node: graphNodeById.get(edge.to) ?? null }))
      .filter((item) => item.node);
  }, [combinedEdges, graphNodeById, selectedNode]);

  const handleSelectNode = useCallback((nodeId: string, filePath?: string | null) => {
    setSelectedNodeId(nodeId);
    if (filePath) setSelectedPath(filePath);
  }, []);

  if (error) {
    return (
      <main className="shell">
        <div className="panel empty-state">
          <p className="eyebrow">REPOSITORY UNAVAILABLE</p>
          <h1>{error}</h1>
          <a href="/">Return home</a>
        </div>
      </main>
    );
  }

  const repo = state.repository;
  const repositoryName = repo ? `${repo.identity.owner} / ${repo.identity.name}` : `${repoIdentity.owner} / ${repoIdentity.repo}`;

  return (
    <main className="shell repo-shell">
      <nav>
        <a href="/" className="brand">{PRODUCT_NAME.toUpperCase()}</a>
        <span>GitFlow interactive workspace</span>
      </nav>

      <section className="repo-head">
        <p className="eyebrow">REPOSITORY INTELLIGENCE GRAPH</p>
        <h1>{repositoryName}</h1>
        {repo ? (
          <p className="muted">
            Default branch <b>{repo.defaultBranch}</b> · commit <code>{repo.sha}</code>
          </p>
        ) : (
          <p className="muted">Resolving repository snapshot and analysis metadata…</p>
        )}
      </section>

      <section className="status-panel panel">
        <div className="panel-title">
          <span>Snapshot processing</span>
          <b>{state.job?.progress ?? 0}%</b>
        </div>
        <div className="bar"><i style={{ width: `${state.job?.progress ?? 0}%` }} /></div>
        <p className="muted">
          Stage: {state.job?.stage ?? 'resolving'} · {state.job?.status ?? 'queued'}
        </p>
      </section>

      <section className="workspace">
        {/* Left Navigation Panel: Discovered Flows & Repository Files */}
        <aside className="left panel">
          <div className="panel-heading">
            <span>GitFlow Entrypoints</span>
            <small>{flowCandidates.length} routes</small>
          </div>

          <div className="flow-panel" style={{ marginTop: '14px' }}>
            {flowCandidates.length > 0 ? (
              <div className="graph-list">
                {flowCandidates.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.id}
                    className={selectedFlowId === candidate.id ? 'graph-node selected' : 'graph-node'}
                    onClick={() => {
                      setSelectedFlowId(candidate.id);
                      setViewMode('flow');
                      if (candidate.evidence?.path) setSelectedPath(candidate.evidence.path);
                    }}
                  >
                    <span className="dot" style={{ background: '#3b82f6' }} />
                    <div>
                      <strong>{candidate.method} {candidate.path}</strong>
                      <em>{candidate.evidence?.path}:{candidate.evidence?.startLine}</em>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty-copy">No statically recognized Express entrypoints were found.</p>
            )}

            {flow ? (
              <div className="meta-box">
                <h4>Discovered Flow {flow.truncated ? '(truncated)' : ''}</h4>
                <ol style={{ paddingLeft: '18px', margin: '8px 0', display: 'grid', gap: '6px' }}>
                  {flow.steps.map((step, idx) => (
                    <li key={step.id}>
                      <button
                        type="button"
                        className="mini-link"
                        onClick={() => {
                          setSelectedNodeId(step.nodeId);
                          if (step.evidence?.path) setSelectedPath(step.evidence.path);
                        }}
                      >
                        {step.label}
                      </button>
                      <small> · {step.role} {step.resolution === 'unresolved' ? '· ⚠ unresolved' : ''}</small>
                    </li>
                  ))}
                </ol>
                <p className="muted" style={{ fontSize: '11px', marginTop: '8px' }}>
                  {flow.limitations[0]}
                </p>
              </div>
            ) : null}
          </div>

          <div className="panel-heading" style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--line)' }}>
            <span>Repository Explorer</span>
            <small>{manifestEntries.length} files</small>
          </div>
          <div className="tree">
            {manifestEntries.length === 0 ? (
              <p className="empty-copy">Inventorying immutable snapshot…</p>
            ) : (
              manifestEntries.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  className={selectedPath === entry.path ? 'file-row selected' : 'file-row'}
                  onClick={() => setSelectedPath(entry.path)}
                >
                  <span className="file-name">{entry.path}</span>
                  <span className="file-meta">{entry.language ?? entry.classification}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Center Panel: Primary Interactive GitFlow Graph Canvas */}
        <section className="center panel">
          <div className="panel-heading">
            <span>Primary Graph Canvas</span>
            <small>
              {viewMode === 'flow' && flow ? `Active Flow (${flow.steps.length} nodes)` : `Full Graph (${combinedNodes.length} nodes, ${combinedEdges.length} edges)`}
            </small>
          </div>

          <div className="graph-toolbar">
            <input
              className="graph-search"
              type="search"
              value={searchTerm}
              placeholder="Filter graph nodes or search symbols"
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm ? (
              <button type="button" className="ghost-button" onClick={() => setSearchTerm('')}>
                Clear
              </button>
            ) : null}
          </div>

          {state.analysis?.status && (state.analysis.status === 'completed' || state.analysis.status === 'partial') ? (
            <GitFlowGraph
              nodes={searchTerm ? visibleNodes : combinedNodes}
              edges={combinedEdges}
              flow={flow}
              selectedNodeId={selectedNodeId}
              onSelectNode={handleSelectNode}
              onExpandNode={handleExpandNode}
              isExpanding={isExpanding}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />
          ) : (
            <div className="empty-copy" style={{ padding: '60px 20px', textAlign: 'center' }}>
              {state.snapshot?.status === 'ready'
                ? 'The analysis worker is graphing the resolved snapshot…'
                : 'The worker is resolving the public repository archive…'}
            </div>
          )}

          {expandError ? (
            <p className="error" style={{ marginTop: '8px' }}>Expansion failed: {expandError}</p>
          ) : null}
        </section>

        {/* Right Panel: Contextual Node Details & Source Inspector */}
        <aside className="right panel">
          <div className="panel-heading">
            <span>Node Inspector</span>
            <small>{selectedNode?.type ?? 'none'}</small>
          </div>

          {selectedNode ? (
            <div className="detail-block">
              <h3>{selectedNode.evidence?.name ?? selectedNode.key}</h3>
              <p className="muted">
                {selectedNode.type} · {selectedNode.evidence?.path ?? 'no file evidence'}
                {selectedNode.evidence?.startLine ? `:${selectedNode.evidence.startLine}-${selectedNode.evidence?.endLine ?? selectedNode.evidence.startLine}` : ''}
              </p>

              {/* Progressive Expansion Button */}
              <button
                type="button"
                className="action-button"
                disabled={isExpanding}
                onClick={() => handleExpandNode(selectedNode.id)}
              >
                {isExpanding ? 'Expanding connections…' : '+ Expand Neighborhood in RIG'}
              </button>

              {/* Related graph edges */}
              {relatedEdges.length > 0 && (
                <div className="meta-box">
                  <h4>Graph Relationships ({relatedEdges.length})</h4>
                  <ul>
                    {relatedEdges.map((edge) => {
                      const otherId = edge.from === selectedNode.id ? edge.to : edge.from;
                      const otherNode = graphNodeById.get(otherId);
                      const isOutgoing = edge.from === selectedNode.id;
                      return (
                        <li key={edge.id}>
                          <span>{isOutgoing ? '→' : '←'} <code>{edge.type}</code> ({edge.resolution})</span>
                          {otherNode ? (
                            <button
                              type="button"
                              className="mini-link"
                              style={{ marginLeft: '6px' }}
                              onClick={() => handleSelectNode(otherNode.id, otherNode.evidence?.path ?? selectedPath)}
                            >
                              {otherNode.evidence?.name ?? otherNode.key}
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Inbound & Outbound callers */}
              <div className="relationship-grid">
                <div className="relationship-list">
                  <h4>Inbound Callers</h4>
                  {inboundCalls.length > 0 ? (
                    <ul>
                      {inboundCalls.map(({ edge, node }) => (
                        <li key={edge.id}>
                          <button
                            type="button"
                            className="mini-link"
                            onClick={() => {
                              if (node) handleSelectNode(node.id, node.evidence?.path ?? selectedPath);
                            }}
                          >
                            {node?.evidence?.name ?? node?.key ?? 'caller'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No callers resolved statically.</p>
                  )}
                </div>

                <div className="relationship-list">
                  <h4>Outbound Callees</h4>
                  {outboundCalls.length > 0 ? (
                    <ul>
                      {outboundCalls.map(({ edge, node }) => (
                        <li key={edge.id}>
                          <button
                            type="button"
                            className="mini-link"
                            onClick={() => {
                              if (node) handleSelectNode(node.id, node.evidence?.path ?? selectedPath);
                            }}
                          >
                            {node?.evidence?.name ?? node?.key ?? 'callee'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No callees resolved statically.</p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="empty-copy">Select any node in the graph to inspect its properties and relationships.</p>
          )}

          {/* Immutable Source Viewer */}
          <div className="source-viewer">
            <div className="panel-heading compact">
              <span>Source View</span>
              {selectedPath ? <small>{selectedPath}</small> : null}
            </div>
            {sourceLoading ? (
              <p className="empty-copy">Loading source from snapshot…</p>
            ) : source ? (
              <pre>{source.content}</pre>
            ) : (
              <p className="empty-copy">Select a file or node to view source code.</p>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
