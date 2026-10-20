'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
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
type AnalysisInfo = {
  status: string;
  progress: number;
  diagnostics: { path: string; message: string; startLine?: number; startColumn?: number }[];
};
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

  // Selection states
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Search & Filters
  const [nodeSearchTerm, setNodeSearchTerm] = useState('');
  const [sidebarFilter, setSidebarFilter] = useState('');

  // Panel layout states
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [isSourceDrawerOpen, setIsSourceDrawerOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'flows' | 'files'>('flows');

  // Source inspection
  const [source, setSource] = useState<SourceResponse | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const sourceLineRef = useRef<HTMLDivElement | null>(null);

  // Flow and view states
  const [flowCandidates, setFlowCandidates] = useState<FlowCandidateType[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowType | null>(null);
  const [viewMode, setViewMode] = useState<'flow' | 'full'>('flow');
  const [flowView, setFlowView] = useState<'control' | 'data' | 'all'>('control');
  const [fitViewTrigger, setFitViewTrigger] = useState(0);

  // Progressive neighborhood expansion state
  const [expandedNodes, setExpandedNodes] = useState<Map<string, GraphNodeType>>(new Map());
  const [expandedEdges, setExpandedEdges] = useState<Map<string, GraphEdgeType>>(new Map());
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);

  const repoIdentity = useMemo(
    () => ({ owner: params.owner ?? '', repo: params.repo ?? '' }),
    [params.owner, params.repo]
  );

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
    return () => {
      active = false;
    };
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
    if (
      !state.snapshot?.id ||
      state.analysis?.status === 'completed' ||
      state.analysis?.status === 'partial' ||
      state.analysis?.status === 'failed'
    )
      return;
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
    if (
      !state.snapshot?.id ||
      !state.analysis ||
      (state.analysis.status !== 'completed' && state.analysis.status !== 'partial') ||
      state.graph
    )
      return;
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
    if (
      !state.snapshot?.id ||
      !state.analysis ||
      (state.analysis.status !== 'completed' && state.analysis.status !== 'partial')
    )
      return;
    const snapshotId = state.snapshot.id;
    setFlowCandidates([]);
    setSelectedFlowId(null);
    setFlow(null);
    void fetch(`${API}/snapshots/${snapshotId}/flows?limit=100`)
      .then(async (response) => (response.ok ? response.json() : { candidates: [] }))
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

  // Fetch specific flow sequence when selectedFlowId or flowView changes
  useEffect(() => {
    if (!state.snapshot?.id || !selectedFlowId) return;
    const url = `${API}/snapshots/${state.snapshot.id}/flows/${selectedFlowId}${flowView !== 'control' ? `?view=${flowView}` : ''}`;
    void fetch(url)
      .then(async (response) => (response.ok ? response.json() : null))
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
  }, [state.snapshot?.id, selectedFlowId, flowView]);

  // Progressive graph neighborhood expansion
  const handleExpandNode = useCallback(
    async (nodeId: string) => {
      if (!state.snapshot?.id) return;
      setIsExpanding(true);
      setExpandError(null);
      try {
        const response = await fetch(
          `${API}/snapshots/${state.snapshot.id}/nodes/${encodeURIComponent(nodeId)}/neighborhood?limit=50`
        );
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
    },
    [state.snapshot?.id]
  );

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
  const graphEdgeById = useMemo(() => new Map(combinedEdges.map((edge) => [edge.id, edge])), [combinedEdges]);

  const manifestEntries = state.snapshot?.manifest ?? [];

  // Search filter for graph nodes
  const visibleNodes = useMemo(() => {
    const query = nodeSearchTerm.trim().toLowerCase();
    if (!query) return combinedNodes;
    return combinedNodes.filter((node) => {
      const haystack = [node.evidence?.name, node.key, node.evidence?.path, node.type]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [combinedNodes, nodeSearchTerm]);

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
            setSource({
              path: fallbackPath,
              content: detail.message ?? 'Unable to load source for this file.',
              language: null,
              bytes: 0,
              lineCount: 1,
            });
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
          setSource({
            path: fallbackPath,
            content: 'Unable to load source for this file.',
            language: null,
            bytes: 0,
            lineCount: 1,
          });
        }
      })
      .finally(() => {
        if (!isCancelled) setSourceLoading(false);
      });
    return () => {
      isCancelled = true;
    };
  }, [state.snapshot?.id, selectedPath, combinedNodes]);

  // Active selected node
  const selectedNode = useMemo(() => {
    if (selectedNodeId) {
      const fromGraph = graphNodeById.get(selectedNodeId);
      if (fromGraph) return fromGraph;
      const step = flow?.steps.find((s) => s.nodeId === selectedNodeId);
      if (step) return { id: step.nodeId, type: step.type, key: step.label, evidence: step.evidence ?? null };
    }
    if (selectedPath && !selectedEdgeId) {
      return combinedNodes.find((node) => node.evidence?.path === selectedPath) ?? null;
    }
    return null;
  }, [graphNodeById, combinedNodes, selectedNodeId, selectedPath, selectedEdgeId, flow]);

  // Active selected edge
  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return null;
    return graphEdgeById.get(selectedEdgeId) ?? null;
  }, [graphEdgeById, selectedEdgeId]);

  // Direct incoming and outgoing relationships for the selected node
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
    setSelectedNodeId(nodeId || null);
    setSelectedEdgeId(null);
    if (filePath) {
      setSelectedPath(filePath);
    }
  }, []);

  const handleSelectEdge = useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId);
    if (edgeId) {
      const edge = graphEdgeById.get(edgeId);
      if (edge?.evidence?.path) {
        setSelectedPath(edge.evidence.path);
      }
    }
  }, [graphEdgeById]);

  // Highlight range for source inspection
  const evidenceRange = useMemo(() => {
    if (selectedNode?.evidence?.startLine) {
      return {
        path: selectedNode.evidence.path ?? selectedPath,
        startLine: selectedNode.evidence.startLine,
        endLine: selectedNode.evidence.endLine ?? selectedNode.evidence.startLine,
      };
    }
    if (selectedEdge?.evidence?.startLine) {
      return {
        path: selectedEdge.evidence.path ?? selectedPath,
        startLine: selectedEdge.evidence.startLine,
        endLine: selectedEdge.evidence.startLine,
      };
    }
    return null;
  }, [selectedNode, selectedEdge, selectedPath]);

  // Auto-scroll source drawer when highlight range changes
  useEffect(() => {
    if (isSourceDrawerOpen && evidenceRange && sourceLineRef.current) {
      sourceLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isSourceDrawerOpen, evidenceRange, source?.content]);

  // Filtered sidebar items
  const filteredCandidates = useMemo(() => {
    const q = sidebarFilter.trim().toLowerCase();
    if (!q) return flowCandidates;
    return flowCandidates.filter((c) => {
      return (
        c.path.toLowerCase().includes(q) ||
        c.method.toLowerCase().includes(q) ||
        (c.evidence?.path?.toLowerCase() ?? '').includes(q)
      );
    });
  }, [flowCandidates, sidebarFilter]);

  const filteredManifest = useMemo(() => {
    const q = sidebarFilter.trim().toLowerCase();
    if (!q) return manifestEntries;
    return manifestEntries.filter((m) => {
      return m.path.toLowerCase().includes(q) || (m.language?.toLowerCase() ?? '').includes(q);
    });
  }, [manifestEntries, sidebarFilter]);

  if (error) {
    return (
      <main className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 500, padding: 32, background: '#fff', borderRadius: 8, border: '1px solid var(--line)', textAlign: 'center' }}>
          <p style={{ font: '700 12px var(--font-mono)', color: 'var(--red)', letterSpacing: '0.1em' }}>REPOSITORY UNAVAILABLE</p>
          <h2 style={{ margin: '12px 0 16px' }}>{error}</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 20 }}>
            Unable to locate or resolve this GitHub repository. Please verify the URL.
          </p>
          <a href="/" className="inspector-action-btn" style={{ display: 'inline-flex', width: 'auto', padding: '8px 18px' }}>
            ← Return to GitHow Home
          </a>
        </div>
      </main>
    );
  }

  const repo = state.repository;
  const repositoryTitle = repo ? `${repo.identity.owner} / ${repo.identity.name}` : `${repoIdentity.owner} / ${repoIdentity.repo}`;
  const commitShaShort = repo?.sha ? repo.sha.slice(0, 7) : null;
  const isAnalysisReady = state.analysis?.status === 'completed' || state.analysis?.status === 'partial';

  return (
    <main className="app-shell">
      {/* 1. TOP APPLICATION BAR */}
      <header className="app-header">
        <div className="app-header-left">
          <a href="/" className="brand-link" title="GitHow Platform">
            <span>{PRODUCT_NAME.toUpperCase()}</span>
            <span className="brand-badge">RIG</span>
          </a>

          <div className="header-divider" />

          <div className="repo-breadcrumb">
            <strong>{repositoryTitle}</strong>
            {repo?.defaultBranch ? <span className="repo-meta-tag">{repo.defaultBranch}</span> : null}
            {commitShaShort ? (
              <span className="repo-meta-tag" title={`Resolved commit: ${repo?.sha}`}>
                {commitShaShort}
              </span>
            ) : null}
          </div>
        </div>

        <div className="app-header-center">
          {state.job?.status && state.job.status !== 'completed' ? (
            <span className="status-badge processing">
              <span className="status-pulse" />
              <span>
                {state.job.stage ?? 'processing'} {state.job.progress ?? 0}%
              </span>
            </span>
          ) : isAnalysisReady ? (
            <span className="status-badge ready">
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a' }} />
              <span>Snapshot Analyzed ({combinedNodes.length} nodes)</span>
            </span>
          ) : (
            <span className="status-badge">
              <span className="status-pulse" />
              <span>Resolving repository…</span>
            </span>
          )}
        </div>

        <div className="app-header-right">
          <button
            type="button"
            className={`icon-btn ${isLeftSidebarOpen ? 'active' : ''}`}
            onClick={() => setIsLeftSidebarOpen((v) => !v)}
            title={isLeftSidebarOpen ? 'Collapse Left Sidebar' : 'Expand Left Sidebar'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
            <span>Explorer</span>
          </button>

          <button
            type="button"
            className={`icon-btn ${isSourceDrawerOpen ? 'active' : ''}`}
            onClick={() => setIsSourceDrawerOpen((v) => !v)}
            title={isSourceDrawerOpen ? 'Close Source Drawer' : 'Open Source Drawer'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <span>Source</span>
          </button>

          <button
            type="button"
            className={`icon-btn ${isRightSidebarOpen ? 'active' : ''}`}
            onClick={() => setIsRightSidebarOpen((v) => !v)}
            title={isRightSidebarOpen ? 'Collapse Right Inspector' : 'Expand Right Inspector'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span>Inspector</span>
          </button>

          <a href="/" className="icon-btn" title="Inspect a different repository">
            New Repo
          </a>
        </div>
      </header>

      {/* 2. THREE-PANEL WORKSPACE */}
      <div className="app-workspace">
        {/* A. LEFT SIDEBAR: REPOSITORY EXPLORER & FLOWS */}
        <aside className={`app-sidebar ${isLeftSidebarOpen ? '' : 'collapsed'}`}>
          <div className="sidebar-tabs">
            <button
              type="button"
              className={`sidebar-tab-btn ${sidebarTab === 'flows' ? 'active' : ''}`}
              onClick={() => setSidebarTab('flows')}
            >
              <span>Routes & Flows</span>
              <span className="file-item-badge">{flowCandidates.length}</span>
            </button>
            <button
              type="button"
              className={`sidebar-tab-btn ${sidebarTab === 'files' ? 'active' : ''}`}
              onClick={() => setSidebarTab('files')}
            >
              <span>Files</span>
              <span className="file-item-badge">{manifestEntries.length}</span>
            </button>
          </div>

          <div className="sidebar-search-box">
            <input
              type="search"
              className="sidebar-search-input"
              placeholder={sidebarTab === 'flows' ? 'Filter routes or handlers…' : 'Filter files…'}
              value={sidebarFilter}
              onChange={(e) => setSidebarFilter(e.target.value)}
            />
          </div>

          <div className="sidebar-scroll-area">
            {sidebarTab === 'flows' ? (
              <>
                {filteredCandidates.length > 0 ? (
                  filteredCandidates.map((candidate) => {
                    const isSelected = selectedFlowId === candidate.id;
                    const methodClass = candidate.method.toLowerCase();
                    return (
                      <button
                        type="button"
                        key={candidate.id}
                        className={`flow-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedFlowId(candidate.id);
                          setViewMode('flow');
                          if (candidate.evidence?.path) setSelectedPath(candidate.evidence.path);
                        }}
                      >
                        <div className="flow-item-header">
                          <span className={`method-tag ${methodClass}`}>{candidate.method}</span>
                          <span className="flow-item-path" title={candidate.path}>
                            {candidate.path}
                          </span>
                        </div>
                        {candidate.evidence?.path ? (
                          <span className="flow-item-meta" title={`${candidate.evidence.path}:${candidate.evidence.startLine}`}>
                            {candidate.evidence.path}:{candidate.evidence.startLine}
                          </span>
                        ) : null}
                      </button>
                    );
                  })
                ) : (
                  <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
                    {flowCandidates.length === 0
                      ? 'No statically recognized entrypoints found in this repository.'
                      : 'No routes match your search filter.'}
                  </div>
                )}

                {/* Active Flow Sequence Stepper */}
                {flow ? (
                  <div className="active-flow-stepper">
                    <div className="stepper-heading">
                      <span>Active Flow Sequence</span>
                      <span>{flow.steps.length} steps</span>
                    </div>

                    <ol className="step-list">
                      {flow.steps.map((step) => {
                        const isStepSelected = selectedNodeId === step.nodeId;
                        return (
                          <li key={step.id}>
                            <button
                              type="button"
                              className={`step-row ${isStepSelected ? 'selected' : ''}`}
                              onClick={() => {
                                handleSelectNode(step.nodeId, step.evidence?.path ?? selectedPath);
                              }}
                            >
                              <span className="step-idx">#{step.role === 'entrypoint' ? 1 : step.id.slice(-1) || '•'}</span>
                              <span className="step-name" title={step.label}>
                                {step.label}
                              </span>
                              <span className="step-role-badge">{step.role}</span>
                              {step.resolution === 'unresolved' ? (
                                <span className="step-unresolved-flag" title="Unresolved dynamic dependency">
                                  ⚠
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ol>

                    {flow.limitations && flow.limitations[0] ? (
                      <p style={{ margin: '10px 0 0', fontSize: '11px', color: 'var(--muted)', lineHeight: 1.4 }}>
                        {flow.limitations[0]}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              /* Files Tab */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {filteredManifest.length > 0 ? (
                  filteredManifest.map((entry) => {
                    const isSelected = selectedPath === entry.path;
                    return (
                      <button
                        type="button"
                        key={entry.path}
                        className={`file-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedPath(entry.path);
                          setIsSourceDrawerOpen(true);
                        }}
                      >
                        <span className="file-item-name" title={entry.path}>
                          {entry.path}
                        </span>
                        <span className="file-item-badge">{entry.language ?? entry.classification}</span>
                      </button>
                    );
                  })
                ) : (
                  <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--muted)', fontSize: '12px' }}>
                    {manifestEntries.length === 0
                      ? 'Inventorying repository archive…'
                      : 'No files match your search filter.'}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* B. CENTER WORKSPACE: DOCKED CANVAS TOOLBAR + GRAPH CANVAS + BOTTOM SOURCE DRAWER */}
        <section className="app-canvas-container">
          {/* Docked Canvas Toolbar */}
          <div className="canvas-toolbar">
            <div className="canvas-toolbar-group">
              {/* Primary View Toggle: Flow View vs Full Graph */}
              <div className="segmented-pill-group">
                <button
                  type="button"
                  className={`pill-btn ${viewMode === 'flow' ? 'active' : ''}`}
                  onClick={() => setViewMode('flow')}
                  disabled={!flow}
                  title="Focus on active GitFlow route and sequence"
                >
                  Flow View {flow ? `(${flow.steps.length})` : ''}
                </button>
                <button
                  type="button"
                  className={`pill-btn ${viewMode === 'full' ? 'active' : ''}`}
                  onClick={() => setViewMode('full')}
                  title="Show full repository graph"
                >
                  Full Graph ({combinedNodes.length})
                </button>
              </div>

              {/* Flow Submode View Toggle: Control / Data / Combined */}
              {viewMode === 'flow' ? (
                <div className="segmented-pill-group">
                  <button
                    type="button"
                    className={`pill-btn ${flowView === 'control' ? 'active' : ''}`}
                    onClick={() => setFlowView('control')}
                    title="Control Flow: invocation and call relationships"
                  >
                    Control
                  </button>
                  <button
                    type="button"
                    className={`pill-btn ${flowView === 'data' ? 'active' : ''}`}
                    onClick={() => setFlowView('data')}
                    title="Data Flow: value propagation, parameters, and returns"
                  >
                    Data
                  </button>
                  <button
                    type="button"
                    className={`pill-btn ${flowView === 'all' ? 'active' : ''}`}
                    onClick={() => setFlowView('all')}
                    title="Combined View: control and data flow together"
                  >
                    Combined
                  </button>
                </div>
              ) : null}
            </div>

            <div className="canvas-toolbar-group">
              {/* Search filter for graph canvas */}
              <div className="toolbar-search">
                <input
                  type="search"
                  className="toolbar-search-input"
                  placeholder="Search symbols or nodes…"
                  value={nodeSearchTerm}
                  onChange={(e) => setNodeSearchTerm(e.target.value)}
                />
                {nodeSearchTerm ? (
                  <button
                    type="button"
                    className="toolbar-search-clear"
                    onClick={() => setNodeSearchTerm('')}
                    title="Clear search"
                  >
                    ×
                  </button>
                ) : null}
              </div>

              {nodeSearchTerm ? (
                <span className="file-item-badge" style={{ font: '600 11px var(--font-mono)' }}>
                  {visibleNodes.length} / {combinedNodes.length}
                </span>
              ) : null}

              {/* Fit view action */}
              <button
                type="button"
                className="icon-btn"
                onClick={() => setFitViewTrigger((prev) => prev + 1)}
                title="Fit graph viewport to content"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
                <span>Fit View</span>
              </button>

              {/* Quick neighborhood expansion button if a node is selected */}
              {selectedNode ? (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={isExpanding}
                  onClick={() => handleExpandNode(selectedNode.id)}
                  title="Expand neighbor connections in the repository graph"
                >
                  <span>{isExpanding ? 'Expanding…' : '+ Expand RIG'}</span>
                </button>
              ) : null}
            </div>
          </div>

          {/* Canvas Viewport */}
          {isAnalysisReady ? (
            <GitFlowGraph
              nodes={nodeSearchTerm ? visibleNodes : combinedNodes}
              edges={combinedEdges}
              flow={flow}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectNode={handleSelectNode}
              onSelectEdge={handleSelectEdge}
              onExpandNode={handleExpandNode}
              isExpanding={isExpanding}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              flowView={flowView}
              onFlowViewChange={setFlowView}
              fitViewTrigger={fitViewTrigger}
            />
          ) : (
            <div className="rig-graph-empty-overlay">
              <span className="status-pulse" style={{ width: 14, height: 14, color: 'var(--ink)' }} />
              <p style={{ marginTop: 8, fontWeight: 500 }}>
                {state.snapshot?.status === 'ready'
                  ? 'Static analyzer is constructing repository intelligence graph…'
                  : 'Worker is downloading and validating repository archive…'}
              </p>
              <small style={{ color: 'var(--muted)' }}>Immutable snapshot tied to commit SHA</small>
            </div>
          )}

          {expandError ? (
            <div style={{ position: 'absolute', bottom: 12, left: 16, background: '#fee2e2', border: '1px solid #f87171', padding: '6px 12px', borderRadius: 4, color: '#991b1b', fontSize: 12, zIndex: 30 }}>
              Expansion notice: {expandError}
            </div>
          ) : null}

          {/* C. BOTTOM SOURCE DRAWER */}
          {isSourceDrawerOpen ? (
            <div className="source-drawer">
              <div className="source-drawer-header">
                <div className="source-drawer-title">
                  <span className="source-path-tag">{selectedPath ?? source?.path ?? 'No file selected'}</span>
                  {evidenceRange?.startLine ? (
                    <span className="source-line-tag">
                      {evidenceRange.startLine === evidenceRange.endLine
                        ? `Line ${evidenceRange.startLine}`
                        : `Lines ${evidenceRange.startLine}–${evidenceRange.endLine}`}
                    </span>
                  ) : null}
                  {source?.bytes ? (
                    <span style={{ color: 'var(--muted)', fontSize: '11px' }}>
                      {(source.bytes / 1024).toFixed(1)} KB · {source.lineCount} lines · {source.language ?? 'text'}
                    </span>
                  ) : null}
                </div>

                <div className="source-drawer-actions">
                  {evidenceRange?.startLine ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        sourceLineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}
                    >
                      Jump to line
                    </button>
                  ) : null}

                  <button
                    type="button"
                    className="icon-btn"
                    style={{ padding: '3px 8px', fontSize: '11px' }}
                    onClick={() => setIsSourceDrawerOpen(false)}
                    title="Close source drawer"
                  >
                    Close ×
                  </button>
                </div>
              </div>

              <div className="source-code-container">
                {sourceLoading ? (
                  <div style={{ padding: 24, color: 'var(--muted)', textAlign: 'center', width: '100%' }}>
                    Loading verified source content…
                  </div>
                ) : source ? (
                  <>
                    <div className="source-line-numbers">
                      {source.content.split('\n').map((_, idx) => (
                        <div key={idx} style={{ height: 19 }}>
                          {idx + 1}
                        </div>
                      ))}
                    </div>
                    <pre className="source-code-content">
                      {source.content.split('\n').map((line, idx) => {
                        const lineNum = idx + 1;
                        const isHighlighted =
                          evidenceRange &&
                          lineNum >= evidenceRange.startLine &&
                          lineNum <= evidenceRange.endLine;
                        return (
                          <span
                            key={idx}
                            ref={isHighlighted && lineNum === evidenceRange.startLine ? sourceLineRef : null}
                            className={`source-code-line ${isHighlighted ? 'highlighted' : ''}`}
                          >
                            {line || ' '}
                          </span>
                        );
                      })}
                    </pre>
                  </>
                ) : (
                  <div style={{ padding: 24, color: 'var(--muted)', textAlign: 'center', width: '100%' }}>
                    Select a node or file in the explorer to inspect source code.
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </section>

        {/* C. RIGHT SIDEBAR: CONTEXT INSPECTOR */}
        <aside className={`app-inspector ${isRightSidebarOpen ? '' : 'collapsed'}`}>
          <div className="inspector-header">
            <span>{selectedEdge ? 'Relationship Inspector' : selectedNode ? 'Node Inspector' : 'Inspector'}</span>
            <span className="file-item-badge">
              {selectedEdge ? selectedEdge.type : selectedNode ? selectedNode.type : 'none'}
            </span>
          </div>

          <div className="inspector-scroll-area">
            {selectedEdge ? (
              /* EDGE INSPECTOR VIEW */
              <>
                <div className="inspector-title-card">
                  <div className="inspector-badges-row">
                    <span
                      className="method-tag"
                      style={{
                        backgroundColor:
                          selectedEdge.type === 'FLOWS_TO'
                            ? '#0284c7'
                            : selectedEdge.type === 'RETURNS_TO'
                              ? '#9333ea'
                              : selectedEdge.type === 'ROUTE_HANDLER'
                                ? '#2563eb'
                                : '#17231f',
                      }}
                    >
                      {selectedEdge.type}
                    </span>
                    <span
                      className={
                        selectedEdge.resolution === 'unresolved' ? 'rig-unresolved-badge' : 'file-item-badge'
                      }
                    >
                      {selectedEdge.resolution === 'unresolved' ? '⚠ Unresolved' : 'Observed'}
                    </span>
                  </div>

                  <h3 className="inspector-symbol-name" style={{ fontSize: 16 }}>
                    Relationship Details
                  </h3>
                </div>

                {/* From / To Node Jump Links */}
                <div className="inspector-section">
                  <div className="inspector-section-heading">Connected Endpoints</div>
                  <div className="inspector-data-grid">
                    <span className="inspector-data-label">Source Node</span>
                    <button
                      type="button"
                      className="link-button"
                      style={{ textAlign: 'left', wordBreak: 'break-all' }}
                      onClick={() => handleSelectNode(selectedEdge.from, null)}
                    >
                      {graphNodeById.get(selectedEdge.from)?.evidence?.name ??
                        graphNodeById.get(selectedEdge.from)?.key ??
                        selectedEdge.from}
                    </button>

                    <span className="inspector-data-label">Target Node</span>
                    <button
                      type="button"
                      className="link-button"
                      style={{ textAlign: 'left', wordBreak: 'break-all' }}
                      onClick={() => handleSelectNode(selectedEdge.to, null)}
                    >
                      {graphNodeById.get(selectedEdge.to)?.evidence?.name ??
                        graphNodeById.get(selectedEdge.to)?.key ??
                        selectedEdge.to}
                    </button>
                  </div>
                </div>

                {/* Evidence & Location */}
                {selectedEdge.evidence?.path ? (
                  <div className="inspector-section">
                    <div className="inspector-section-heading">Source Evidence</div>
                    <div className="inspector-file-location">
                      <span>
                        {selectedEdge.evidence.path}
                        {selectedEdge.evidence.startLine ? `:${selectedEdge.evidence.startLine}` : ''}
                      </span>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          if (selectedEdge.evidence?.path) {
                            setSelectedPath(selectedEdge.evidence.path);
                            setIsSourceDrawerOpen(true);
                          }
                        }}
                      >
                        View Source
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Transformation & Channel Attributes */}
                {selectedEdge.evidence?.attributes ? (
                  <div className="inspector-section">
                    <div className="inspector-section-heading">Data Flow Metadata</div>
                    <div className="inspector-data-grid">
                      {Object.entries(selectedEdge.evidence.attributes).map(([key, val]) => (
                        <div key={key} style={{ display: 'contents' }}>
                          <span className="inspector-data-label">{key}</span>
                          <span className="inspector-data-val">{String(val)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : selectedNode ? (
              /* NODE INSPECTOR VIEW */
              <>
                <div className="inspector-title-card">
                  <div className="inspector-badges-row">
                    <span
                      className="method-tag"
                      style={{
                        backgroundColor:
                          selectedNode.type === 'route'
                            ? '#2563eb'
                            : selectedNode.type === 'symbol'
                              ? '#059669'
                              : selectedNode.type === 'file'
                                ? '#0891b2'
                                : '#17231f',
                      }}
                    >
                      {selectedNode.type}
                    </span>
                    <span
                      className={
                        selectedNode.key.startsWith('unresolved') ? 'rig-unresolved-badge' : 'file-item-badge'
                      }
                    >
                      {selectedNode.key.startsWith('unresolved') ? '⚠ Unresolved Boundary' : 'Static Node'}
                    </span>
                  </div>

                  <h3 className="inspector-symbol-name">{selectedNode.evidence?.name ?? selectedNode.key}</h3>

                  {selectedNode.evidence?.path ? (
                    <div className="inspector-file-location">
                      <span title={selectedNode.evidence.path}>
                        {selectedNode.evidence.path}
                        {selectedNode.evidence.startLine
                          ? `:${selectedNode.evidence.startLine}${
                              selectedNode.evidence.endLine && selectedNode.evidence.endLine !== selectedNode.evidence.startLine
                                ? `–${selectedNode.evidence.endLine}`
                                : ''
                            }`
                          : ''}
                      </span>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          if (selectedNode.evidence?.path) {
                            setSelectedPath(selectedNode.evidence.path);
                            setIsSourceDrawerOpen(true);
                          }
                        }}
                      >
                        View Source
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* Expansion Action */}
                <button
                  type="button"
                  className="inspector-action-btn"
                  disabled={isExpanding}
                  onClick={() => handleExpandNode(selectedNode.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>{isExpanding ? 'Expanding Neighborhood…' : 'Expand Neighborhood in RIG'}</span>
                </button>

                {/* Node Attributes & Role */}
                {selectedNode.evidence?.attributes && Object.keys(selectedNode.evidence.attributes).length > 0 ? (
                  <div className="inspector-section">
                    <div className="inspector-section-heading">Properties</div>
                    <div className="inspector-data-grid">
                      {Object.entries(selectedNode.evidence.attributes).map(([k, v]) => (
                        <div key={k} style={{ display: 'contents' }}>
                          <span className="inspector-data-label">{k}</span>
                          <span className="inspector-data-val">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Inbound Callers */}
                <div className="inspector-section">
                  <div className="inspector-section-heading">
                    <span>Inbound Callers</span>
                    <span className="file-item-badge">{inboundCalls.length}</span>
                  </div>
                  {inboundCalls.length > 0 ? (
                    <ul className="rel-list">
                      {inboundCalls.map(({ edge, node }) => (
                        <li key={edge.id} className="rel-row">
                          <span className="rel-arrow">←</span>
                          <span className="rel-type-tag">CALLS</span>
                          <button
                            type="button"
                            className="rel-target-btn"
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
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No callers statically resolved.</p>
                  )}
                </div>

                {/* Outbound Callees */}
                <div className="inspector-section">
                  <div className="inspector-section-heading">
                    <span>Outbound Callees</span>
                    <span className="file-item-badge">{outboundCalls.length}</span>
                  </div>
                  {outboundCalls.length > 0 ? (
                    <ul className="rel-list">
                      {outboundCalls.map(({ edge, node }) => (
                        <li key={edge.id} className="rel-row">
                          <span className="rel-arrow">→</span>
                          <span className="rel-type-tag">CALLS</span>
                          <button
                            type="button"
                            className="rel-target-btn"
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
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No callees statically resolved.</p>
                  )}
                </div>

                {/* Connected Relationships */}
                {relatedEdges.length > 0 && (
                  <div className="inspector-section">
                    <div className="inspector-section-heading">
                      <span>Connected Relationships</span>
                      <span className="file-item-badge">{relatedEdges.length}</span>
                    </div>
                    <ul className="rel-list">
                      {relatedEdges.map((edge) => {
                        const isOutgoing = edge.from === selectedNode.id;
                        const otherId = isOutgoing ? edge.to : edge.from;
                        const otherNode = graphNodeById.get(otherId);
                        const isSelectedRel = edge.id === selectedEdgeId;

                        return (
                          <li
                            key={edge.id}
                            className="rel-row"
                            style={isSelectedRel ? { borderColor: 'var(--ink)', background: 'var(--panel-hover)' } : {}}
                          >
                            <span className="rel-arrow">{isOutgoing ? '→' : '←'}</span>
                            <span
                              className="rel-type-tag"
                              style={{
                                color:
                                  edge.type === 'FLOWS_TO'
                                    ? '#0284c7'
                                    : edge.type === 'RETURNS_TO'
                                      ? '#9333ea'
                                      : 'inherit',
                              }}
                            >
                              {edge.type}
                            </span>
                            <button
                              type="button"
                              className="rel-target-btn"
                              onClick={() => {
                                handleSelectEdge(edge.id);
                              }}
                            >
                              {otherNode?.evidence?.name ?? otherNode?.key ?? otherId}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              /* EMPTY INSPECTOR STATE */
              <div className="inspector-empty">
                <div className="inspector-empty-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </div>
                <h4>Context Inspector</h4>
                <p>
                  Select any node or relationship in the graph canvas to inspect its source location, declaration, and
                  data-flow attributes.
                </p>

                <div
                  style={{
                    width: '100%',
                    background: 'var(--panel-soft)',
                    border: '1px solid var(--line-subtle)',
                    borderRadius: 6,
                    padding: 10,
                    marginTop: 12,
                    textAlign: 'left',
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--muted)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span>Active View:</span>
                    <strong style={{ color: 'var(--ink)' }}>{viewMode === 'flow' ? `Flow (${flowView})` : 'Full Graph'}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span>Visible Nodes:</span>
                    <strong style={{ color: 'var(--ink)' }}>{visibleNodes.length}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Visible Edges:</span>
                    <strong style={{ color: 'var(--ink)' }}>{combinedEdges.length}</strong>
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
