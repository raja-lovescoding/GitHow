import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('API contracts', () => {
  it('rejects invalid submissions', async () => { const app = createApp(); const response = await app.inject({ method: 'POST', url: '/repos', payload: { url: 'https://gitlab.com/a/b' } }); expect(response.statusCode).toBe(400); expect(response.json().error).toBe('invalid_repository_url'); });
  it('reuses a snapshot for the same resolved SHA', async () => { let calls = 0; const app = createApp({ resolve: async (identity) => { calls++; return { identity, defaultBranch: 'main', description: null, visibility: 'public', sha: 'a'.repeat(40) }; } }); const payload = { url: 'https://github.com/owner/repo' }; const first = await app.inject({ method: 'POST', url: '/repos', payload }); const second = await app.inject({ method: 'POST', url: '/repos', payload }); expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(200); expect(second.json().reused).toBe(true); expect(calls).toBe(2); });
});
