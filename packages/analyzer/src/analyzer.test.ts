import { describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';
import { assembleFlow, findFlowCandidates } from './flow.js';

describe('analyzeRepository', () => {
  it('extracts deterministic source-backed declarations and relative imports', () => {
    const files = [
      { path: 'src/main.ts', content: "import { helper } from './helper'; export function main() { return helper(); }" },
      { path: 'src/helper.ts', content: 'export const helper = () => 1;' },
    ];
    const first = analyzeRepository({ snapshotId: 'snapshot-1', files });
    const second = analyzeRepository({ snapshotId: 'snapshot-1', files: [...files].reverse() });
    expect(second).toEqual(first);
    expect(first.nodes.some((node) => node.type === 'symbol' && node.evidence?.name === 'main')).toBe(true);
    expect(first.edges.some((edge) => edge.type === 'IMPORTS' && edge.resolution === 'resolved')).toBe(true);
  });

  it('retains parse diagnostics without discarding other files', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-2', files: [{ path: 'broken.ts', content: 'function broken( {' }, { path: 'ok.ts', content: 'export function ok() {}' }] });
    expect(result.diagnostics.some((diagnostic) => diagnostic.path === 'broken.ts')).toBe(true);
    expect(result.nodes.some((node) => node.evidence?.path === 'ok.ts' && node.evidence.name === 'ok')).toBe(true);
  });

  it('observes CommonJS require and exports', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-3', files: [{ path: 'src/main.js', content: "const helper = require('./helper'); module.exports = helper;" }, { path: 'src/helper.js', content: 'module.exports = () => 1;' }] });
    expect(result.edges.some((edge) => edge.type === 'IMPORTS' && edge.resolution === 'resolved')).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'EXPORTS')).toBe(true);
  });

  it('captures direct symbol-to-symbol call relationships', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-4', files: [{ path: 'src/index.ts', content: 'export function helper() { return 1; } export function main() { return helper(); }' }] });
    expect(result.edges.some((edge) => edge.type === 'CALLS' && edge.resolution === 'resolved')).toBe(true);
    expect(result.nodes.some((node) => node.type === 'symbol' && node.evidence?.name === 'main')).toBe(true);
  });

  it('extracts source-backed Express routes, middleware, and inline handlers', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-express', files: [{ path: 'src/app.ts', content: "import express from 'express'; const app = express(); const guard = (req, res, next) => next(); function listUsers(req, res) { return res.json([]); } app.get('/users', guard, listUsers); app.post('/users', (req, res) => res.sendStatus(201));" }] });
    const candidates = findFlowCandidates(result);
    expect(candidates).toHaveLength(2);
    const firstCandidate = candidates.find((candidate) => candidate.method === 'GET');
    if (!firstCandidate) throw new Error('Expected a GET Express route candidate.');
    expect(firstCandidate).toMatchObject({ method: 'GET', path: '/users' });
    const getRoute = result.nodes.find((node) => node.type === 'route' && node.evidence?.attributes?.method === 'GET');
    expect(getRoute).toBeDefined();
    expect(result.edges.some((edge) => edge.type === 'MIDDLEWARE' && edge.resolution === 'resolved')).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'ROUTE_HANDLER' && edge.resolution === 'resolved')).toBe(true);
    const flow = assembleFlow(result, firstCandidate.id);
    expect(flow?.steps.some((step) => step.role === 'handler')).toBe(true);
    expect(flow?.steps.every((step) => step.evidence?.path === 'src/app.ts')).toBe(true);
  });

  it('keeps unresolved route handlers explicit', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-unresolved', files: [{ path: 'src/app.js', content: "const express = require('express'); const app = express(); app.get('/missing', missingHandler);" }] });
    const candidate = findFlowCandidates(result)[0];
    if (!candidate) throw new Error('Expected an Express route candidate.');
    expect(result.edges.some((edge) => edge.type === 'ROUTE_HANDLER' && edge.resolution === 'unresolved')).toBe(true);
    expect(assembleFlow(result, candidate?.id)?.steps.some((step) => step.resolution === 'unresolved')).toBe(true);
  });

  it('composes a static router mount prefix without treating the mount as an endpoint', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-mount', files: [{ path: 'src/app.ts', content: "import express from 'express'; const app = express(); const router = express.Router(); app.use('/api', router); router.get('/users/:id', (req, res) => res.send(req.params.id));" }] });
    expect(findFlowCandidates(result).map((candidate) => candidate.path)).toEqual(['/api/users/:id']);
  });

  it('extracts chained router route registrations', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-chain', files: [{ path: 'src/app.js', content: "const express = require('express'); const router = express.Router(); router.route('/users').get((req, res) => res.send('ok')).put((req, res) => res.send('ok'));" }] });
    expect(findFlowCandidates(result).map((candidate) => candidate.method).sort()).toEqual(['GET', 'PUT']);
  });

  it('resolves a named cross-file controller handler and its downstream call', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-cross-file', files: [
      { path: 'src/app.ts', content: "import express from 'express'; import { listUsers } from './controller'; const app = express(); app.get('/users', listUsers);" },
      { path: 'src/controller.ts', content: "import { loadUsers } from './service'; export function listUsers(req, res) { return res.json(loadUsers()); }" },
      { path: 'src/service.ts', content: 'export function loadUsers() { return []; }' },
    ] });
    const candidate = findFlowCandidates(result).find((item) => item.method === 'GET');
    if (!candidate) throw new Error('Expected a cross-file route candidate.');
    const flow = assembleFlow(result, candidate.id);
    expect(flow?.steps.map((step) => step.evidence?.path)).toEqual(['src/app.ts', 'src/controller.ts', 'src/service.ts']);
    expect(flow?.relationships.every((relationship) => relationship.resolution === 'resolved')).toBe(true);
  });

  it('keeps an imported handler unresolved when the export is not statically established', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-cross-file-unresolved', files: [
      { path: 'src/app.ts', content: "import express from 'express'; import { missing } from './controller'; const app = express(); app.get('/missing', missing);" },
      { path: 'src/controller.ts', content: 'const missing = dynamicLookup();' },
    ] });
    const candidate = findFlowCandidates(result)[0];
    if (!candidate) throw new Error('Expected an unresolved route candidate.');
    expect(result.edges.some((edge) => edge.type === 'ROUTE_HANDLER' && edge.resolution === 'unresolved')).toBe(true);
  });

  it('resolves CommonJS controller object methods and downstream service calls', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-cjs-controller', files: [
      { path: 'src/app.js', content: "const express = require('express'); const userController = require('./user.controller'); const app = express(); app.get('/users', userController.getUsers);" },
      { path: 'src/user.controller.js', content: "const userService = require('./user.service'); const getUsers = async (req, res) => { const users = await userService.queryUsers(); res.json(users); }; module.exports = { getUsers };" },
      { path: 'src/user.service.js', content: "const queryUsers = async () => []; module.exports = { queryUsers };" },
    ] });
    const candidate = findFlowCandidates(result).find((item) => item.method === 'GET');
    if (!candidate) throw new Error('Expected CommonJS route candidate');
    const flow = assembleFlow(result, candidate.id);
    expect(flow?.steps.map((step) => step.evidence?.path)).toEqual(['src/app.js', 'src/user.controller.js', 'src/user.service.js']);
    expect(flow?.relationships.every((rel) => rel.resolution === 'resolved')).toBe(true);
  });

  it('propagates cross-file router mount prefixes and unwraps async wrappers', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-cross-file-mount', files: [
      { path: 'src/app.ts', content: "import express from 'express'; import userRouter from './routes/user'; const app = express(); app.use('/api', userRouter);" },
      { path: 'src/routes/user.ts', content: "import { Router } from 'express'; import { getUser } from '../controllers/user'; const router = Router(); const catchAsync = (fn) => fn; router.get('/profile', catchAsync(getUser)); export default router;" },
      { path: 'src/controllers/user.ts', content: "import { findUser } from '../services/user'; export const getUser = (req, res) => res.json(findUser());" },
      { path: 'src/services/user.ts', content: "export const findUser = () => ({ id: 1 });" },
    ] });
    const candidates = findFlowCandidates(result);
    expect(candidates.map((c) => c.path)).toContain('/api/profile');
    const profileCandidate = candidates.find((c) => c.path === '/api/profile');
    if (!profileCandidate) throw new Error('Expected /api/profile candidate');
    const flow = assembleFlow(result, profileCandidate.id);
    expect(flow?.steps.map((s) => s.evidence?.path)).toEqual(['src/routes/user.ts', 'src/controllers/user.ts', 'src/services/user.ts']);
    expect(flow?.relationships.every((r) => r.resolution === 'resolved')).toBe(true);
  });

  it('unpacks nested middleware arrays and middleware factory calls', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-nested-middleware', files: [
      { path: 'src/app.ts', content: "import express from 'express'; const app = express(); const auth = (role: string) => (req: any, res: any, next: any) => next(); const validate = (schema: any) => (req: any, res: any, next: any) => next(); const schema = {}; const handler = (req: any, res: any) => res.json([]); app.post('/items', [auth('admin'), [validate(schema)]], handler);" },
    ] });
    const candidates = findFlowCandidates(result);
    expect(candidates).toHaveLength(1);
    const flow = assembleFlow(result, candidates[0]!.id);
    expect(flow).toBeDefined();
    expect(flow?.steps.some((step) => step.role === 'middleware')).toBe(true);
    expect(flow?.steps.some((step) => step.role === 'handler')).toBe(true);
    expect(result.edges.filter((edge) => edge.type === 'MIDDLEWARE')).toHaveLength(2);
    expect(result.edges.filter((edge) => edge.type === 'ROUTE_HANDLER')).toHaveLength(1);
  });

  it('resolves controller handlers exported through CommonJS barrel index re-exports', () => {
    const result = analyzeRepository({ snapshotId: 'snapshot-cjs-barrel', files: [
      { path: 'src/app.js', content: "const express = require('express'); const { userController } = require('./controllers'); const app = express(); app.get('/users', userController.getUsers);" },
      { path: 'src/controllers/index.js', content: "const userController = require('./user.controller'); module.exports = { userController };" },
      { path: 'src/controllers/user.controller.js', content: "const getUsers = (req, res) => res.send('ok'); module.exports = { getUsers };" },
    ] });
    const candidate = findFlowCandidates(result)[0];
    if (!candidate) throw new Error('Expected candidate');
    const flow = assembleFlow(result, candidate.id);
    expect(flow?.steps.some((s) => s.evidence?.path === 'src/controllers/user.controller.js')).toBe(true);
    expect(flow?.relationships.some((r) => r.resolution === 'resolved')).toBe(true);
  });
});
