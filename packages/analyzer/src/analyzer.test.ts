import { describe, expect, it } from 'vitest';
import { analyzeRepository, createDefaultAnalyzerRegistry } from './analyzer.js';
import { assembleFlow, findFlowCandidates } from './flow.js';

describe('analyzeRepository', () => {
  it('extracts deterministic source-backed declarations and relative imports', async () => {
    const files = [
      { path: 'src/main.ts', content: "import { helper } from './helper'; export function main() { return helper(); }" },
      { path: 'src/helper.ts', content: 'export const helper = () => 1;' },
    ];
    const first = await analyzeRepository({ snapshotId: 'snapshot-1', files });
    const second = await analyzeRepository({ snapshotId: 'snapshot-1', files: [...files].reverse() });
    expect(second).toEqual(first);
    expect(first.nodes.some((node) => node.type === 'symbol' && node.evidence?.name === 'main')).toBe(true);
    expect(first.edges.some((edge) => edge.type === 'IMPORTS' && edge.resolution === 'resolved')).toBe(true);
  });

  it('retains parse diagnostics without discarding other files', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-2', files: [{ path: 'broken.ts', content: 'function broken( {' }, { path: 'ok.ts', content: 'export function ok() {}' }] });
    expect(result.diagnostics.some((diagnostic) => diagnostic.path === 'broken.ts')).toBe(true);
    expect(result.nodes.some((node) => node.evidence?.path === 'ok.ts' && node.evidence.name === 'ok')).toBe(true);
  });

  it('observes CommonJS require and exports', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-3', files: [{ path: 'src/main.js', content: "const helper = require('./helper'); module.exports = helper;" }, { path: 'src/helper.js', content: 'module.exports = () => 1;' }] });
    expect(result.edges.some((edge) => edge.type === 'IMPORTS' && edge.resolution === 'resolved')).toBe(true);
    expect(result.edges.some((edge) => edge.type === 'EXPORTS')).toBe(true);
  });

  it('captures direct symbol-to-symbol call relationships', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-4', files: [{ path: 'src/index.ts', content: 'export function helper() { return 1; } export function main() { return helper(); }' }] });
    expect(result.edges.some((edge) => edge.type === 'CALLS' && edge.resolution === 'resolved')).toBe(true);
    expect(result.nodes.some((node) => node.type === 'symbol' && node.evidence?.name === 'main')).toBe(true);
  });

  it('extracts source-backed Express routes, middleware, and inline handlers', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-express', files: [{ path: 'src/app.ts', content: "import express from 'express'; const app = express(); const guard = (req, res, next) => next(); function listUsers(req, res) { return res.json([]); } app.get('/users', guard, listUsers); app.post('/users', (req, res) => res.sendStatus(201));" }] });
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

  it('keeps unresolved route handlers explicit', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-unresolved', files: [{ path: 'src/app.js', content: "const express = require('express'); const app = express(); app.get('/missing', missingHandler);" }] });
    const candidate = findFlowCandidates(result)[0];
    if (!candidate) throw new Error('Expected an Express route candidate.');
    expect(result.edges.some((edge) => edge.type === 'ROUTE_HANDLER' && edge.resolution === 'unresolved')).toBe(true);
    expect(assembleFlow(result, candidate?.id)?.steps.some((step) => step.resolution === 'unresolved')).toBe(true);
  });

  it('composes a static router mount prefix without treating the mount as an endpoint', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-mount', files: [{ path: 'src/app.ts', content: "import express from 'express'; const app = express(); const router = express.Router(); app.use('/api', router); router.get('/users/:id', (req, res) => res.send(req.params.id));" }] });
    expect(findFlowCandidates(result).map((candidate) => candidate.path)).toEqual(['/api/users/:id']);
  });

  it('extracts chained router route registrations', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-chain', files: [{ path: 'src/app.js', content: "const express = require('express'); const router = express.Router(); router.route('/users').get((req, res) => res.send('ok')).put((req, res) => res.send('ok'));" }] });
    expect(findFlowCandidates(result).map((candidate) => candidate.method).sort()).toEqual(['GET', 'PUT']);
  });

  it('resolves a named cross-file controller handler and its downstream call', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-cross-file', files: [
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

  it('keeps an imported handler unresolved when the export is not statically established', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-cross-file-unresolved', files: [
      { path: 'src/app.ts', content: "import express from 'express'; import { missing } from './controller'; const app = express(); app.get('/missing', missing);" },
      { path: 'src/controller.ts', content: 'const missing = dynamicLookup();' },
    ] });
    const candidate = findFlowCandidates(result)[0];
    if (!candidate) throw new Error('Expected an unresolved route candidate.');
    expect(result.edges.some((edge) => edge.type === 'ROUTE_HANDLER' && edge.resolution === 'unresolved')).toBe(true);
  });

  it('resolves CommonJS controller object methods and downstream service calls', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-cjs-controller', files: [
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

  it('propagates cross-file router mount prefixes and unwraps async wrappers', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-cross-file-mount', files: [
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

  it('unpacks nested middleware arrays and middleware factory calls', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-nested-middleware', files: [
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

  it('resolves controller handlers exported through CommonJS barrel index re-exports', async () => {
    const result = await analyzeRepository({ snapshotId: 'snapshot-cjs-barrel', files: [
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

  it('inventories all manifest source and config files in the RIG so any repository is explorable', async () => {
    const manifest = [
      { path: 'src/main.ts', size: 100, sha256: 'a'.repeat(64), extension: '.ts', language: 'typescript', classification: 'source' as const },
      { path: 'server.py', size: 200, sha256: 'b'.repeat(64), extension: '.py', language: 'python', classification: 'source' as const },
      { path: 'Cargo.toml', size: 50, sha256: 'c'.repeat(64), extension: '.toml', language: 'toml', classification: 'source' as const },
      { path: 'README.md', size: 120, sha256: 'd'.repeat(64), extension: '.md', language: 'markdown', classification: 'source' as const },
      { path: 'logo.png', size: 500, sha256: 'e'.repeat(64), extension: '.png', language: null, classification: 'binary' as const },
    ];
    const files = [{ path: 'src/main.ts', content: 'export function run() { return 1; }' }];
    const result = await analyzeRepository({ snapshotId: 'snapshot-multi-lang', files, manifest });

    const filePaths = result.nodes.filter((n) => n.type === 'file').map((n) => n.key);
    expect(filePaths).toContain('src/main.ts');
    expect(filePaths).toContain('server.py');
    expect(filePaths).toContain('Cargo.toml');
    expect(filePaths).toContain('README.md');
    // Binary asset excluded from source node inventory
    expect(filePaths).not.toContain('logo.png');

    const containsPy = result.edges.some((e) => e.type === 'CONTAINS' && e.evidence.path === 'server.py');
    expect(containsPy).toBe(true);
  });

  /* -------------------------------------------------------------------------- */
  /* Python Language Adapter Tests                                              */
  /* -------------------------------------------------------------------------- */
  describe('Python language adapter', () => {
    it('extracts functions, classes, methods, inheritance, and direct calls', async () => {
      const pythonContent = `
import math
from .service import query_data

PI = 3.14159

class BaseService:
    def execute(self):
        return True

class DataService(BaseService):
    async def fetch(self):
        return self.execute()

def main():
    service = DataService()
    service.fetch()
`;
      const result = await analyzeRepository({
        snapshotId: 'snap-py-1',
        files: [{ path: 'app.py', content: pythonContent }],
      });

      // File node & contains
      expect(result.nodes.some((n) => n.type === 'file' && n.key === 'app.py')).toBe(true);
      expect(result.edges.some((e) => e.type === 'CONTAINS' && e.evidence.path === 'app.py')).toBe(true);

      // Symbols: class, methods, functions, variables
      const symbols = result.nodes.filter((n) => n.type === 'symbol');
      expect(symbols.some((s) => s.evidence?.name === 'BaseService' && s.evidence?.attributes?.kind === 'class')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'DataService' && s.evidence?.attributes?.kind === 'class')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'BaseService.execute' && s.evidence?.attributes?.kind === 'method')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'DataService.fetch' && s.evidence?.attributes?.async === true)).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'main' && s.evidence?.attributes?.kind === 'function')).toBe(true);

      // Class inheritance
      const extendsEdge = result.edges.find((e) => e.type === 'EXTENDS');
      expect(extendsEdge).toBeDefined();
      expect(extendsEdge?.resolution).toBe('resolved');

      // Calls
      expect(result.edges.some((e) => e.type === 'CALLS')).toBe(true);

      // Imports
      expect(result.edges.some((e) => e.type === 'IMPORTS' && e.evidence.name === 'math')).toBe(true);
    });

    it('captures Python syntax error diagnostics without throwing', async () => {
      const result = await analyzeRepository({
        snapshotId: 'snap-py-broken',
        files: [
          { path: 'broken.py', content: 'def unclosed(a, b:\n    return 1' },
          { path: 'valid.py', content: 'def ok(): return 42' },
        ],
      });
      expect(result.diagnostics.some((d) => d.path === 'broken.py')).toBe(true);
      expect(result.nodes.some((n) => n.evidence?.path === 'valid.py' && n.evidence.name === 'ok')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Go Language Adapter Tests                                                  */
  /* -------------------------------------------------------------------------- */
  describe('Go language adapter', () => {
    it('extracts structs, interfaces, methods with receivers, and function calls', async () => {
      const goContent = `
package main

import (
    "fmt"
    "net/http"
)

type Worker interface {
    DoWork() error
}

type Service struct {
    Name string
}

func (s *Service) DoWork() error {
    return nil
}

func Start() {
    s := &Service{Name: "worker-1"}
    s.DoWork()
}
`;
      const result = await analyzeRepository({
        snapshotId: 'snap-go-1',
        files: [{ path: 'main.go', content: goContent }],
      });

      // File node
      expect(result.nodes.some((n) => n.type === 'file' && n.key === 'main.go')).toBe(true);

      // Symbols: interface, struct, method, function
      const symbols = result.nodes.filter((n) => n.type === 'symbol');
      expect(symbols.some((s) => s.evidence?.name === 'Worker' && s.evidence?.attributes?.kind === 'interface')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'Service' && s.evidence?.attributes?.kind === 'struct')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'Service.DoWork' && s.evidence?.attributes?.kind === 'method')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'Start' && s.evidence?.attributes?.kind === 'function')).toBe(true);

      // Method declared on struct
      expect(result.edges.some((e) => e.type === 'DECLARES' && e.evidence.name === 'Service.DoWork')).toBe(true);

      // Calls
      expect(result.edges.some((e) => e.type === 'CALLS')).toBe(true);

      // Imports
      expect(result.edges.some((e) => e.type === 'IMPORTS' && e.evidence.name === 'fmt')).toBe(true);
    });

    it('captures Go syntax errors without failing analysis', async () => {
      const result = await analyzeRepository({
        snapshotId: 'snap-go-err',
        files: [{ path: 'bad.go', content: 'package main\nfunc incomplete(' }],
      });
      expect(result.diagnostics.some((d) => d.path === 'bad.go')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Rust Language Adapter Tests                                                */
  /* -------------------------------------------------------------------------- */
  describe('Rust language adapter', () => {
    it('extracts structs, enums, traits, impl blocks, and trait implementations', async () => {
      const rustContent = `
mod helpers;
use std::collections::HashMap;

pub trait Handler {
    fn handle(&self) -> bool;
}

pub struct Server {
    pub port: u16,
}

pub enum Protocol {
    Http,
    Https,
}

impl Handler for Server {
    fn handle(&self) -> bool {
        true
    }
}

impl Server {
    pub fn new(port: u16) -> Self {
        Server { port }
    }
}

pub fn main() {
    let s = Server::new(8080);
    s.handle();
}
`;
      const result = await analyzeRepository({
        snapshotId: 'snap-rs-1',
        files: [{ path: 'src/main.rs', content: rustContent }],
      });

      // File node
      expect(result.nodes.some((n) => n.type === 'file' && n.key === 'src/main.rs')).toBe(true);

      // Symbols: trait, struct, enum, functions, impl methods
      const symbols = result.nodes.filter((n) => n.type === 'symbol');
      expect(symbols.some((s) => s.evidence?.name === 'Handler' && s.evidence?.attributes?.kind === 'trait')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'Server' && s.evidence?.attributes?.kind === 'struct')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'Protocol' && s.evidence?.attributes?.kind === 'enum')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'Server::new')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'Server::handle')).toBe(true);
      expect(symbols.some((s) => s.evidence?.name === 'main')).toBe(true);

      // Trait implementation: Server IMPLEMENTS Handler
      const implEdge = result.edges.find((e) => e.type === 'IMPLEMENTS');
      expect(implEdge).toBeDefined();
      expect(implEdge?.resolution).toBe('resolved');

      // Module and use imports
      expect(result.edges.some((e) => e.type === 'IMPORTS' && e.evidence.name === 'helpers')).toBe(true);
      expect(result.edges.some((e) => e.type === 'IMPORTS' && e.evidence.name === 'std::collections::HashMap')).toBe(true);

      // Direct calls
      expect(result.edges.some((e) => e.type === 'CALLS')).toBe(true);
    });

    it('captures Rust syntax error diagnostics without halting analysis', async () => {
      const result = await analyzeRepository({
        snapshotId: 'snap-rs-err',
        files: [{ path: 'bad.rs', content: 'fn broken( { let x =' }],
      });
      expect(result.diagnostics.some((d) => d.path === 'bad.rs')).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Multi-Language Mixed Repository Tests                                      */
  /* -------------------------------------------------------------------------- */
  describe('Multi-language repository integration', () => {
    it('analyzes mixed TypeScript, Python, Go, and Rust repositories with deterministic IDs', async () => {
      const files = [
        { path: 'src/index.ts', content: 'export function tsHello() { return "hello"; }' },
        { path: 'py/worker.py', content: 'def py_task():\n    return 42\n' },
        { path: 'backend/server.go', content: 'package main\nfunc GoRun() {}\n' },
        { path: 'core/lib.rs', content: 'pub fn rust_compute() -> i32 { 100 }\n' },
      ];

      const first = await analyzeRepository({ snapshotId: 'snap-polyglot', files });
      const second = await analyzeRepository({ snapshotId: 'snap-polyglot', files: [...files].reverse() });

      // Deterministic IDs across repeated runs with reversed order
      expect(second.nodes.map((n) => n.id).sort()).toEqual(first.nodes.map((n) => n.id).sort());
      expect(second.edges.map((e) => e.id).sort()).toEqual(first.edges.map((e) => e.id).sort());

      // Contains all languages
      const symbolNames = first.nodes.filter((n) => n.type === 'symbol').map((n) => n.evidence?.name);
      expect(symbolNames).toContain('tsHello');
      expect(symbolNames).toContain('py_task');
      expect(symbolNames).toContain('GoRun');
      expect(symbolNames).toContain('rust_compute');
    });

    it('provides registry lookup for all 7 supported framework adapters', () => {
      const registry = createDefaultAnalyzerRegistry();
      expect(registry.listLanguageAdapters()).toHaveLength(3);
      expect(registry.listFrameworkAdapters()).toHaveLength(7);
      const frameworkIds = registry.listFrameworkAdapters().map((f) => f.id);
      expect(frameworkIds).toContain('express');
      expect(frameworkIds).toContain('fastify');
      expect(frameworkIds).toContain('flask');
      expect(frameworkIds).toContain('fastapi');
      expect(frameworkIds).toContain('gin');
      expect(frameworkIds).toContain('actix-web');
      expect(frameworkIds).toContain('axum');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Phase 4: Framework Intelligence & Entry-Point Discovery                    */
  /* -------------------------------------------------------------------------- */
  describe('Phase 4: Framework Intelligence', () => {
    describe('Fastify Framework Discovery', () => {
      it('discovers route shorthands, route objects, register plugins, and hooks', async () => {
        const files = [
          {
            path: 'src/server.ts',
            content: `
import fastify from 'fastify';
import { userPlugin } from './plugin';

const app = fastify();
const authHook = async (req: any, reply: any) => {};
const listUsers = async (req: any, reply: any) => [];

app.addHook('onRequest', authHook);
app.get('/health', async () => ({ status: 'ok' }));
app.route({
  method: ['GET', 'POST'],
  url: '/users',
  handler: listUsers,
});
app.register(userPlugin, { prefix: '/v1' });
`,
          },
          {
            path: 'src/plugin.ts',
            content: `
export async function userPlugin(instance: any) {
  instance.get('/profile', async () => ({ user: 'admin' }));
}
`,
          },
        ];

        const result = await analyzeRepository({ snapshotId: 'snap-fastify', files });

        // Candidates: /health, /users (GET & POST), /v1/profile
        const candidates = findFlowCandidates(result);
        const paths = candidates.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain('GET /health');
        expect(paths).toContain('GET /users');
        expect(paths).toContain('POST /users');
        expect(paths).toContain('GET /v1/profile');

        // Verify HOOK edge
        const hookEdge = result.edges.find((e) => e.type === 'HOOK');
        expect(hookEdge).toBeDefined();
        expect(hookEdge?.resolution).toBe('resolved');
        expect(hookEdge?.evidence.attributes?.hookName).toBe('onRequest');

        // Verify PLUGIN edge
        const pluginEdge = result.edges.find((e) => e.type === 'PLUGIN');
        expect(pluginEdge).toBeDefined();
        expect(pluginEdge?.resolution).toBe('resolved');

        // Flow assembly
        const userFlowCandidate = candidates.find((c) => c.path === '/users' && c.method === 'GET');
        if (!userFlowCandidate) throw new Error('Expected /users candidate');
        const flow = assembleFlow(result, userFlowCandidate.id);
        expect(flow?.steps.some((s) => s.role === 'handler')).toBe(true);
      });

      it('correctly marks unresolved handlers in Fastify routes', async () => {
        const files = [
          {
            path: 'src/app.ts',
            content: `
import fastify from 'fastify';
const app = fastify();
app.get('/missing', missingFastifyHandler);
`,
          },
        ];
        const result = await analyzeRepository({ snapshotId: 'snap-fastify-unresolved', files });
        const unresEdge = result.edges.find((e) => e.type === 'ROUTE_HANDLER' && e.resolution === 'unresolved');
        expect(unresEdge).toBeDefined();
      });
    });

    describe('Flask Framework Discovery', () => {
      it('discovers routes, blueprints, prefix propagation, and request hooks', async () => {
        const files = [
          {
            path: 'app.py',
            content: `
from flask import Flask
from routes import auth_bp

app = Flask(__name__)
app.register_blueprint(auth_bp, url_prefix="/api")

@app.before_request
def global_before():
    pass

@app.route("/health", methods=["GET"])
def health_check():
    return "ok"
`,
          },
          {
            path: 'routes.py',
            content: `
from flask import Blueprint

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")

@auth_bp.route("/login", methods=["POST"])
def login_handler():
    return "logged_in"
`,
          },
        ];

        const result = await analyzeRepository({ snapshotId: 'snap-flask', files });

        const candidates = findFlowCandidates(result);
        const paths = candidates.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain('GET /health');
        expect(paths).toContain('POST /api/auth/login');

        // Verify MOUNTS edge between app and auth_bp
        const mountEdge = result.edges.find((e) => e.type === 'MOUNTS');
        expect(mountEdge).toBeDefined();
        expect(mountEdge?.resolution).toBe('resolved');

        // Verify HOOK edge for before_request
        const hookEdge = result.edges.find((e) => e.type === 'HOOK');
        expect(hookEdge).toBeDefined();
        expect(hookEdge?.resolution).toBe('resolved');
        expect(hookEdge?.evidence.attributes?.hookName).toBe('before_request');

        // Verify ROUTE_HANDLER resolved to login_handler
        const loginCandidate = candidates.find((c) => c.path === '/api/auth/login');
        if (!loginCandidate) throw new Error('Expected login route candidate');
        const flow = assembleFlow(result, loginCandidate.id);
        expect(flow?.steps.some((s) => s.label === 'login_handler' && s.resolution === 'resolved')).toBe(true);
      });
    });

    describe('FastAPI Framework Discovery', () => {
      it('discovers APIRouter, include_router prefixes, and Depends declarations', async () => {
        const files = [
          {
            path: 'main.py',
            content: `
from fastapi import FastAPI, Depends
from routers import items_router

app = FastAPI()
app.include_router(items_router, prefix="/api")

def verify_token():
    return True

@app.get("/status", dependencies=[Depends(verify_token)])
def status():
    return {"status": "ok"}
`,
          },
          {
            path: 'routers.py',
            content: `
from fastapi import APIRouter, Depends

items_router = APIRouter(prefix="/v1")

def get_db():
    return {}

@items_router.post("/items")
def create_item(db = Depends(get_db)):
    return {"created": True}
`,
          },
        ];

        const result = await analyzeRepository({ snapshotId: 'snap-fastapi', files });

        const candidates = findFlowCandidates(result);
        const paths = candidates.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain('GET /status');
        expect(paths).toContain('POST /api/v1/items');

        // Verify DEPENDS_ON edges
        const depEdges = result.edges.filter((e) => e.type === 'DEPENDS_ON');
        expect(depEdges.length).toBeGreaterThanOrEqual(2);
        expect(depEdges.every((e) => e.resolution === 'resolved')).toBe(true);

        // Verify Flow includes dependency step
        const statusCandidate = candidates.find((c) => c.path === '/status');
        if (!statusCandidate) throw new Error('Expected status candidate');
        const flow = assembleFlow(result, statusCandidate.id);
        expect(flow?.steps.some((s) => s.role === 'dependency')).toBe(true);
      });

      it('marks missing Depends functions as unresolved dependencies', async () => {
        const files = [
          {
            path: 'app.py',
            content: `
from fastapi import FastAPI, Depends
app = FastAPI()

@app.get("/items")
def get_items(db = Depends(missing_db_session)):
    return []
`,
          },
        ];
        const result = await analyzeRepository({ snapshotId: 'snap-fastapi-unres', files });
        const unresDep = result.edges.find((e) => e.type === 'DEPENDS_ON' && e.resolution === 'unresolved');
        expect(unresDep).toBeDefined();
      });
    });

    describe('Gin Framework Discovery', () => {
      it('discovers gin engine, nested route groups, middleware, and handlers', async () => {
        const files = [
          {
            path: 'main.go',
            content: `package main

import "github.com/gin-gonic/gin"

func authMiddleware(c *gin.Context) {}

func ping(c *gin.Context) {}

func createUser(c *gin.Context) {}

func main() {
    r := gin.Default()
    r.Use(authMiddleware)
    r.GET("/ping", ping)

    v1 := r.Group("/v1")
    users := v1.Group("/users")
    users.POST("/create", createUser)
}
`,
          },
        ];

        const result = await analyzeRepository({ snapshotId: 'snap-gin', files });

        const candidates = findFlowCandidates(result);
        const paths = candidates.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain('GET /ping');
        expect(paths).toContain('POST /v1/users/create');

        // Middleware edge
        expect(result.edges.some((e) => e.type === 'MIDDLEWARE' && e.resolution === 'resolved')).toBe(true);

        // Mounts edges for nested groups
        const mountEdges = result.edges.filter((e) => e.type === 'MOUNTS');
        expect(mountEdges.length).toBeGreaterThanOrEqual(1);

        // Handler edges
        const pingRoute = candidates.find((c) => c.path === '/ping');
        if (!pingRoute) throw new Error('Expected ping candidate');
        const flow = assembleFlow(result, pingRoute.id);
        expect(flow?.steps.some((s) => s.label === 'ping' && s.resolution === 'resolved')).toBe(true);
      });
    });

    describe('Actix Web Framework Discovery', () => {
      it('discovers attribute route macros with attribute line evidence', async () => {
        const files = [
          {
            path: 'src/main.rs',
            content: `
use actix_web::{get, post, web, App, HttpServer, Responder};

#[get("/users")]
async fn get_users() -> impl Responder {
    "users"
}

#[post("/users/new")]
async fn create_user() -> impl Responder {
    "created"
}
`,
          },
        ];

        const result = await analyzeRepository({ snapshotId: 'snap-actix', files });

        const candidates = findFlowCandidates(result);
        const paths = candidates.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain('GET /users');
        expect(paths).toContain('POST /users/new');

        const getRouteNode = result.nodes.find((n) => n.evidence?.attributes?.path === '/users');
        expect(getRouteNode).toBeDefined();
        // Route evidence points to #[get("/users")]
        expect(getRouteNode?.evidence?.startLine).toBe(4);

        const routeHandlerEdge = result.edges.find((e) => e.type === 'ROUTE_HANDLER' && e.from === getRouteNode?.id);
        expect(routeHandlerEdge).toBeDefined();
        expect(routeHandlerEdge?.resolution).toBe('resolved');
      });
    });

    describe('Axum Framework Discovery', () => {
      it('discovers Router method chains, get/post method routers, nest prefixes, and layers', async () => {
        const files = [
          {
            path: 'src/main.rs',
            content: `
use axum::{routing::{get, post}, Router};

async fn list_users() -> &'static str { "users" }
async fn create_user() -> &'static str { "created" }
async fn get_item() -> &'static str { "item" }
async fn my_layer() {}

fn app() -> Router {
    let sub = Router::new().route("/items", get(get_item));

    Router::new()
        .route("/users", get(list_users).post(create_user))
        .nest("/api", sub)
        .layer(my_layer)
}
`,
          },
        ];

        const result = await analyzeRepository({ snapshotId: 'snap-axum', files });

        const candidates = findFlowCandidates(result);
        const paths = candidates.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain('GET /users');
        expect(paths).toContain('POST /users');
        expect(paths).toContain('GET /api/items');

        // Middleware layer edge
        expect(result.edges.some((e) => e.type === 'MIDDLEWARE' && e.resolution === 'resolved')).toBe(true);

        // Nest MOUNTS edge
        expect(result.edges.some((e) => e.type === 'MOUNTS' && e.resolution === 'resolved')).toBe(true);

        // Resolved handler flow
        const userGetCandidate = candidates.find((c) => c.path === '/users' && c.method === 'GET');
        if (!userGetCandidate) throw new Error('Expected /users candidate');
        const flow = assembleFlow(result, userGetCandidate.id);
        expect(flow?.steps.some((s) => s.label === 'list_users' && s.resolution === 'resolved')).toBe(true);
      });

      it('does not infer router composition from non-Router chained calls', async () => {
        const files = [
          {
            path: 'src/builder.rs',
            content: `
struct QueryBuilder;
impl QueryBuilder {
    fn new() -> Self { Self }
    fn route(&self, p: &str) -> &Self { self }
}
fn query() {
    let q = QueryBuilder::new().route("/select");
}
`,
          },
        ];
        const result = await analyzeRepository({ snapshotId: 'snap-non-axum', files });
        expect(findFlowCandidates(result)).toHaveLength(0);
      });
    });
  });
});
