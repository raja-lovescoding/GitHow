import { describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from './app.js';
import { AnalysisStore } from './store.js';
import { createMemoryPersistence } from './persistence.js';

describe('API contracts', () => {
  function testApp(resolve: AppOptions['resolve']) { const store = new AnalysisStore(); return createApp({ store, persistence: createMemoryPersistence(store), queue: { publish: async () => undefined }, resolve }); }
  it('rejects invalid submissions', async () => { const app = testApp(undefined); const response = await app.inject({ method: 'POST', url: '/repos', payload: { url: 'https://gitlab.com/a/b' } }); expect(response.statusCode).toBe(400); expect(response.json().error).toBe('invalid_repository_url'); });
  it('reuses a snapshot for the same resolved SHA', async () => { let calls = 0; const app = testApp(async (identity) => { calls++; return { identity, defaultBranch: 'main', description: null, visibility: 'public', sha: 'a'.repeat(40) }; }); const payload = { url: 'https://github.com/owner/repo' }; const first = await app.inject({ method: 'POST', url: '/repos', payload }); const second = await app.inject({ method: 'POST', url: '/repos', payload }); expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(200); expect(second.json().reused).toBe(true); expect(calls).toBe(2); });
  it('marks a persisted job failed when queue publishing fails', async () => { const store = new AnalysisStore(); const app = createApp({ store, persistence: createMemoryPersistence(store), queue: { publish: async () => { throw new Error('offline'); } }, resolve: async (identity) => ({ identity, defaultBranch: 'main', description: null, visibility: 'public', sha: 'b'.repeat(40) }) }); const response = await app.inject({ method: 'POST', url: '/repos', payload: { url: 'https://github.com/owner/repo' } }); expect(response.statusCode).toBe(503); expect([...store.jobs.values()][0]?.status).toBe('failed'); });
  it('returns a bounded empty graph for memory persistence', async () => { const app = testApp(undefined); const response = await app.inject({ method: 'GET', url: '/snapshots/not-a-real-id/graph?limit=10' }); expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ nodes: [], edges: [] }); });
  it('rejects unbounded graph requests', async () => { const app = testApp(undefined); const response = await app.inject({ method: 'GET', url: '/snapshots/id/graph?limit=5001' }); expect(response.statusCode).toBe(400); });
  it('returns route candidates scoped to the requested snapshot', async () => { const app = testApp(undefined); const response = await app.inject({ method: 'GET', url: '/snapshots/snapshot-id/flows?limit=10' }); expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ snapshotId: 'snapshot-id', candidates: [] }); });
  it('rejects unbounded flow candidate requests', async () => { const app = testApp(undefined); const response = await app.inject({ method: 'GET', url: '/snapshots/id/flows?limit=101' }); expect(response.statusCode).toBe(400); });
  it('returns 404 when a flow candidate is not found', async () => { const app = testApp(undefined); const response = await app.inject({ method: 'GET', url: '/snapshots/snapshot-id/flows/flow_nonexistent' }); expect(response.statusCode).toBe(404); expect(response.json()).toMatchObject({ error: 'not_found' }); });
  it('returns flow candidates and assembles discovered flow from graph nodes', async () => {
    const store = new AnalysisStore();
    const mockPersistence = {
      ...createMemoryPersistence(store),
      getGraph: async () => ({
        nodes: [
          { id: 'route-1', type: 'route', key: 'src/app.ts:1:GET:/users', snapshotId: 'snap-1', analyzerVersion: 'v1', evidence: { path: 'src/app.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 20, attributes: { method: 'GET', path: '/users', framework: 'express', kind: 'endpoint' } } },
          { id: 'handler-1', type: 'symbol', key: 'listUsers', snapshotId: 'snap-1', analyzerVersion: 'v1', evidence: { path: 'src/controller.ts', startLine: 5, startColumn: 1, endLine: 8, endColumn: 2, name: 'listUsers' } },
        ],
        edges: [
          { id: 'edge-1', type: 'ROUTE_HANDLER', from: 'route-1', to: 'handler-1', resolution: 'resolved', snapshotId: 'snap-1', analyzerVersion: 'v1', evidence: { path: 'src/app.ts', startLine: 1, startColumn: 10, endLine: 1, endColumn: 19 } },
        ],
      }),
    };
    const app = createApp({ store, persistence: mockPersistence as never, queue: { publish: async () => undefined } });
    const listResponse = await app.inject({ method: 'GET', url: '/snapshots/snap-1/flows' });
    expect(listResponse.statusCode).toBe(200);
    const candidates = listResponse.json().candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ method: 'GET', path: '/users' });
    const detailResponse = await app.inject({ method: 'GET', url: `/snapshots/snap-1/flows/${candidates[0].id}` });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: candidates[0].id,
      snapshotId: 'snap-1',
      candidate: { method: 'GET', path: '/users' },
      steps: expect.arrayContaining([expect.objectContaining({ role: 'entrypoint' }), expect.objectContaining({ role: 'handler' })]),
      relationships: expect.arrayContaining([expect.objectContaining({ type: 'ROUTE_HANDLER', resolution: 'resolved' })]),
    });
  });
  it('returns node neighborhood and enforces limit bounds', async () => {
    const store = new AnalysisStore();
    const mockPersistence = {
      ...createMemoryPersistence(store),
      getNodeNeighborhood: async (_s: string, _v: string, _schema: string, nodeId: string) => ({
        nodes: [{ id: nodeId, type: 'symbol', key: 'listUsers' }, { id: 'other', type: 'symbol', key: 'queryUsers' }],
        edges: [{ id: 'edge-1', type: 'CALLS', from: nodeId, to: 'other', resolution: 'resolved' }],
      }),
    };
    const app = createApp({ store, persistence: mockPersistence as never, queue: { publish: async () => undefined } });
    const okResponse = await app.inject({ method: 'GET', url: '/snapshots/snap-1/nodes/node-1/neighborhood?limit=10' });
    expect(okResponse.statusCode).toBe(200);
    expect(okResponse.json().nodes).toHaveLength(2);
    const badLimit = await app.inject({ method: 'GET', url: '/snapshots/snap-1/nodes/node-1/neighborhood?limit=500' });
    expect(badLimit.statusCode).toBe(400);
  });

  it('assembles discovered flows with dependency, hook, and plugin relationships', async () => {
    const store = new AnalysisStore();
    const mockPersistence = {
      ...createMemoryPersistence(store),
      getGraph: async () => ({
        nodes: [
          { id: 'route-fastapi', type: 'route', key: 'app.py:1:GET:/items', snapshotId: 'snap-2', analyzerVersion: 'v1', evidence: { path: 'app.py', startLine: 1, startColumn: 1, endLine: 1, endColumn: 20, attributes: { method: 'GET', path: '/items', framework: 'fastapi', kind: 'endpoint' } } },
          { id: 'handler-fastapi', type: 'symbol', key: 'read_items', snapshotId: 'snap-2', analyzerVersion: 'v1', evidence: { path: 'app.py', startLine: 2, startColumn: 1, endLine: 4, endColumn: 20, name: 'read_items' } },
          { id: 'dep-db', type: 'symbol', key: 'get_db', snapshotId: 'snap-2', analyzerVersion: 'v1', evidence: { path: 'deps.py', startLine: 1, startColumn: 1, endLine: 3, endColumn: 10, name: 'get_db' } },
        ],
        edges: [
          { id: 'edge-handler', type: 'ROUTE_HANDLER', from: 'route-fastapi', to: 'handler-fastapi', resolution: 'resolved', snapshotId: 'snap-2', analyzerVersion: 'v1', evidence: { path: 'app.py', startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 } },
          { id: 'edge-dep', type: 'DEPENDS_ON', from: 'handler-fastapi', to: 'dep-db', resolution: 'resolved', snapshotId: 'snap-2', analyzerVersion: 'v1', evidence: { path: 'app.py', startLine: 2, startColumn: 1, endLine: 2, endColumn: 30, name: 'Depends(get_db)' } },
        ],
      }),
    };
    const app = createApp({ store, persistence: mockPersistence as never, queue: { publish: async () => undefined } });
    const listResponse = await app.inject({ method: 'GET', url: '/snapshots/snap-2/flows' });
    expect(listResponse.statusCode).toBe(200);
    const candidate = listResponse.json().candidates[0];
    const detailResponse = await app.inject({ method: 'GET', url: `/snapshots/snap-2/flows/${candidate.id}` });
    expect(detailResponse.statusCode).toBe(200);
    const flowData = detailResponse.json();
    expect(flowData.steps.some((s: { role: string; label: string }) => s.role === 'dependency' && s.label === 'get_db')).toBe(true);
    expect(flowData.relationships.some((r: { type: string }) => r.type === 'DEPENDS_ON')).toBe(true);
  });
});
