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
});
