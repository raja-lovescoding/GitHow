'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const PRODUCT_NAME = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'GitHow';

type ManifestEntry = { path: string; size: number; language: string | null; classification: string };
type RepositoryInfo = { identity: { owner: string; name: string }; defaultBranch: string; sha: string };
type JobInfo = { id: string; status: string; stage: string; progress: number };
type AnalysisInfo = { status: string; progress: number; diagnostics: { path: string; message: string; startLine?: number; startColumn?: number }[] };
type GraphNode = { id: string; type: string; key: string; evidence: { path?: string; name?: string; startLine?: number; startColumn?: number } | null };
type GraphEdge = { id: string; type: string; from: string; to: string; resolution: string; evidence: { path?: string; name?: string; startLine?: number; startColumn?: number } | null };
type SourceResponse = { path: string; content: string; language: string | null; bytes: number; lineCount: number };
type State = {
  repository?: RepositoryInfo;
  snapshot?: { id: string; status: string; manifest: ManifestEntry[] };
  job?: JobInfo;
  analysis?: AnalysisInfo;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] };
};

const nodePalette: Record<string, string> = {
  snapshot: '#c9f269',
  file: '#9fe7d7',
  symbol: '#f1c27d',
  module: '#d8b4fe',
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

  const repoIdentity = useMemo(() => ({ owner: params.owner ?? '', repo: params.repo ?? '' }), [params.owner, params.repo]);

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

  const manifestEntries = state.snapshot?.manifest ?? [];
  const graphNodes = state.graph?.nodes ?? [];
  const graphEdges = state.graph?.edges ?? [];
  const graphNodeById = useMemo(() => new Map(graphNodes.map((node) => [node.id, node])), [graphNodes]);
  const visibleNodes = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return graphNodes;
    return graphNodes.filter((node) => {
      const haystack = [node.evidence?.name, node.key, node.evidence?.path].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [graphNodes, searchTerm]);

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

  useEffect(() => {
    const fallbackPath = selectedPath ?? graphNodes.find((node) => node.evidence?.path)?.evidence?.path ?? null;
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
  }, [state.snapshot?.id, selectedPath, graphNodes]);

  const selectedNode = useMemo(() => {
    if (selectedNodeId) return graphNodeById.get(selectedNodeId) ?? null;
    if (selectedPath) return graphNodes.find((node) => node.evidence?.path === selectedPath) ?? null;
    return null;
  }, [graphNodeById, graphNodes, selectedNodeId, selectedPath]);
  const relatedEdges = useMemo(() => {
    if (!selectedNode) return [];
    return graphEdges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id);
  }, [graphEdges, selectedNode]);
  const inboundCalls = useMemo(() => {
    if (!selectedNode) return [];
    return graphEdges
      .filter((edge) => edge.type === 'CALLS' && edge.to === selectedNode.id)
      .map((edge) => ({ edge, node: graphNodeById.get(edge.from) ?? null }))
      .filter((item) => item.node);
  }, [graphEdges, graphNodeById, selectedNode]);
  const outboundCalls = useMemo(() => {
    if (!selectedNode) return [];
    return graphEdges
      .filter((edge) => edge.type === 'CALLS' && edge.from === selectedNode.id)
      .map((edge) => ({ edge, node: graphNodeById.get(edge.to) ?? null }))
      .filter((item) => item.node);
  }, [graphEdges, graphNodeById, selectedNode]);

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
        <span>GitFlow workspace</span>
      </nav>

      <section className="repo-head">
        <p className="eyebrow">PUBLIC REPOSITORY</p>
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
        <aside className="left panel">
          <div className="panel-heading">
            <span>Repository explorer</span>
            <small>{manifestEntries.length} files</small>
          </div>
          <div className="tree">
            {manifestEntries.length === 0 ? (
              <p className="empty-copy">Inventorying the immutable snapshot…</p>
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

        <section className="center panel">
          <div className="panel-heading">
            <span>Graph</span>
            <small>{visibleNodes.length} matches</small>
          </div>
          <div className="graph-toolbar">
            <input
              className="graph-search"
              type="search"
              value={searchTerm}
              placeholder="Search symbols or file paths"
              onChange={(event) => setSearchTerm(event.target.value)}
            />
            {searchTerm ? (
              <button type="button" className="ghost-button" onClick={() => setSearchTerm('')}>
                Clear
              </button>
            ) : null}
          </div>
          {state.analysis?.status && (state.analysis.status === 'completed' || state.analysis.status === 'partial') ? (
            visibleNodes.length > 0 ? (
              <div className="graph-list">
                {visibleNodes.slice(0, 40).map((node) => (
                  <button
                    type="button"
                    key={node.id}
                    className={selectedNodeId === node.id ? 'graph-node selected' : 'graph-node'}
                    onClick={() => {
                      const path = node.evidence?.path ?? selectedPath;
                      setSelectedNodeId(node.id);
                      setSelectedPath(path ?? null);
                    }}
                  >
                    <span className="dot" style={{ background: nodePalette[node.type] ?? '#c9f269' }} />
                    <div>
                      <strong>{node.evidence?.name ?? node.key}</strong>
                      <em>{node.type}</em>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-copy">No symbols match “{searchTerm}”. Try searching for a function, file, or class name.</div>
            )
          ) : (
            <div className="empty-copy">
              {state.snapshot?.status === 'ready'
                ? 'The analysis worker is graphing the resolved snapshot.'
                : 'The worker is still resolving the public repository archive.'}
            </div>
          )}
        </section>

        <aside className="right panel">
          <div className="panel-heading">
            <span>Details</span>
            <small>{selectedNode?.type ?? 'file'}</small>
          </div>
          {selectedNode ? (
            <div className="detail-block">
              <h3>{selectedNode.evidence?.name ?? selectedNode.key}</h3>
              <p className="muted">{selectedNode.type} · {selectedNode.evidence?.path ?? 'no file evidence'}</p>
              {relatedEdges.length > 0 && (
                <div className="meta-box">
                  <h4>Relationships</h4>
                  <ul>
                    {relatedEdges.map((edge) => (
                      <li key={edge.id}><code>{edge.type}</code> · {edge.resolution}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="relationship-grid">
                <div className="relationship-list">
                  <h4>What calls this</h4>
                  {inboundCalls.length > 0 ? (
                    <ul>
                      {inboundCalls.map(({ edge, node }) => (
                        <li key={edge.id}>
                          <button type="button" className="mini-link" onClick={() => {
                            if (node) {
                              setSelectedNodeId(node.id);
                              setSelectedPath(node.evidence?.path ?? selectedPath ?? null);
                            }
                          }}>
                            {node?.evidence?.name ?? node?.key ?? 'call site'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No call sites were statically resolved.</p>
                  )}
                </div>
                <div className="relationship-list">
                  <h4>What this calls</h4>
                  {outboundCalls.length > 0 ? (
                    <ul>
                      {outboundCalls.map(({ edge, node }) => (
                        <li key={edge.id}>
                          <button type="button" className="mini-link" onClick={() => {
                            if (node) {
                              setSelectedNodeId(node.id);
                              setSelectedPath(node.evidence?.path ?? selectedPath ?? null);
                            }
                          }}>
                            {node?.evidence?.name ?? node?.key ?? 'target'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No callees were statically resolved.</p>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <div className="source-viewer">
            <div className="panel-heading compact">
              <span>Source</span>
              {selectedPath ? <small>{selectedPath}</small> : null}
            </div>
            {sourceLoading ? <p className="empty-copy">Loading source…</p> : source ? (
              <pre>{source.content}</pre>
            ) : (
              <p className="empty-copy">Select a file to load its immutable source view.</p>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
