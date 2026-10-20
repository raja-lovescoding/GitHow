import { describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.js';

describe('Cross-File Semantic Resolution Pipeline', () => {
  /* -------------------------------------------------------------------------- */
  /* JavaScript & TypeScript Fixtures                                           */
  /* -------------------------------------------------------------------------- */
  describe('TypeScript / JavaScript Resolution', () => {
    it('resolves cross-file imported calls across named imports and aliases', async () => {
      const files = [
        { path: 'src/main.ts', content: "import { compute as calc } from './math'; export function run() { return calc(10); }" },
        { path: 'src/math.ts', content: 'export function compute(x: number) { return x * 2; }' },
      ];
      const result = await analyzeRepository({ snapshotId: 'ts-call-1', files });

      const runSymbol = result.nodes.find((n) => n.type === 'symbol' && n.evidence?.name === 'run');
      const computeSymbol = result.nodes.find((n) => n.type === 'symbol' && n.evidence?.name === 'compute');
      expect(runSymbol).toBeDefined();
      expect(computeSymbol).toBeDefined();

      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === runSymbol?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(computeSymbol?.id);
      expect(callEdge?.resolution).toBe('resolved');
      expect(callEdge?.evidence.name).toBe('calc');
    });

    it('resolves cross-file calls through barrel files and star re-exports', async () => {
      const files = [
        { path: 'src/index.ts', content: "import { processPayment } from './services'; export function checkout() { return processPayment(); }" },
        { path: 'src/services/index.ts', content: "export * from './payment'; export * from './order';" },
        { path: 'src/services/payment.ts', content: 'export function processPayment() { return true; }' },
        { path: 'src/services/order.ts', content: 'export function createOrder() { return 1; }' },
      ];
      const result = await analyzeRepository({ snapshotId: 'ts-barrel-1', files });

      const checkoutSym = result.nodes.find((n) => n.evidence?.name === 'checkout');
      const paymentSym = result.nodes.find((n) => n.evidence?.name === 'processPayment');
      expect(checkoutSym).toBeDefined();
      expect(paymentSym).toBeDefined();

      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === checkoutSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(paymentSym?.id);
      expect(callEdge?.resolution).toBe('resolved');
    });

    it('resolves class methods called on instances and handles class inheritance', async () => {
      const files = [
        {
          path: 'src/app.ts',
          content: "import { UserService } from './user.service'; export function start() { const s = new UserService(); return s.getUsers(); }",
        },
        {
          path: 'src/user.service.ts',
          content: "import { BaseService } from './base.service'; export class UserService extends BaseService { getUsers() { return []; } }",
        },
        {
          path: 'src/base.service.ts',
          content: 'export class BaseService { log() {} }',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'ts-class-1', files });

      const startSym = result.nodes.find((n) => n.evidence?.name === 'start');
      const getUsersSym = result.nodes.find((n) => n.evidence?.name === 'UserService.getUsers');
      const baseClassSym = result.nodes.find((n) => n.evidence?.name === 'BaseService');
      const userClassSym = result.nodes.find((n) => n.evidence?.name === 'UserService');

      expect(startSym).toBeDefined();
      expect(getUsersSym).toBeDefined();
      expect(userClassSym).toBeDefined();
      expect(baseClassSym).toBeDefined();

      // Instance call resolved to UserService.getUsers
      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === startSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(getUsersSym?.id);
      expect(callEdge?.resolution).toBe('resolved');

      // EXTENDS edge resolved to BaseService
      const extendsEdge = result.edges.find((e) => e.type === 'EXTENDS' && e.from === userClassSym?.id);
      expect(extendsEdge).toBeDefined();
      expect(extendsEdge?.to).toBe(baseClassSym?.id);
      expect(extendsEdge?.resolution).toBe('resolved');
    });

    it('handles cyclic imports between files without hanging', async () => {
      const files = [
        { path: 'src/a.ts', content: "import { bFunc } from './b'; export function aFunc() { return bFunc(); }" },
        { path: 'src/b.ts', content: "import { aFunc } from './a'; export function bFunc() { return aFunc(); }" },
      ];
      const result = await analyzeRepository({ snapshotId: 'ts-cycle-1', files });

      const aSym = result.nodes.find((n) => n.evidence?.name === 'aFunc');
      const bSym = result.nodes.find((n) => n.evidence?.name === 'bFunc');
      expect(aSym).toBeDefined();
      expect(bSym).toBeDefined();

      const aToBCall = result.edges.find((e) => e.type === 'CALLS' && e.from === aSym?.id);
      const bToACall = result.edges.find((e) => e.type === 'CALLS' && e.from === bSym?.id);
      expect(aToBCall?.to).toBe(bSym?.id);
      expect(aToBCall?.resolution).toBe('resolved');
      expect(bToACall?.to).toBe(aSym?.id);
      expect(bToACall?.resolution).toBe('resolved');
    });

    it('honestly marks unresolved external imports and calls', async () => {
      const files = [
        { path: 'src/api.ts', content: "import axios from 'axios'; export function fetchRemote() { return axios.get('/data'); }" },
      ];
      const result = await analyzeRepository({ snapshotId: 'ts-unresolved-1', files });

      const importEdge = result.edges.find((e) => e.type === 'IMPORTS');
      expect(importEdge).toBeDefined();
      expect(importEdge?.resolution).toBe('unresolved');

      const fetchSym = result.nodes.find((n) => n.evidence?.name === 'fetchRemote');
      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === fetchSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.resolution).toBe('unresolved');
      expect(callEdge?.evidence.reason).toContain('external or unresolved module');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Python Fixtures                                                            */
  /* -------------------------------------------------------------------------- */
  describe('Python Resolution', () => {
    it('resolves multi-level relative imports and submodule calls', async () => {
      const files = [
        {
          path: 'app/controllers/user.py',
          content: 'from ..services.auth import verify_token\ndef login_user():\n    return verify_token("abc")\n',
        },
        {
          path: 'app/services/auth.py',
          content: 'def verify_token(tok):\n    return True\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'py-relative-1', files });

      const loginSym = result.nodes.find((n) => n.evidence?.name === 'login_user');
      const verifySym = result.nodes.find((n) => n.evidence?.name === 'verify_token');
      expect(loginSym).toBeDefined();
      expect(verifySym).toBeDefined();

      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === loginSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(verifySym?.id);
      expect(callEdge?.resolution).toBe('resolved');
    });

    it('resolves imports through __init__.py package barrels', async () => {
      const files = [
        {
          path: 'main.py',
          content: 'from pkg import DataProcessor\ndef run():\n    proc = DataProcessor()\n    return proc.process()\n',
        },
        {
          path: 'pkg/__init__.py',
          content: 'from .processor import DataProcessor\n',
        },
        {
          path: 'pkg/processor.py',
          content: 'class DataProcessor:\n    def process(self):\n        return 42\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'py-barrel-1', files });

      const runSym = result.nodes.find((n) => n.evidence?.name === 'run');
      const classSym = result.nodes.find((n) => n.evidence?.name === 'DataProcessor');
      const processSym = result.nodes.find((n) => n.evidence?.name === 'DataProcessor.process');
      expect(runSym).toBeDefined();
      expect(classSym).toBeDefined();
      expect(processSym).toBeDefined();

      const calls = result.edges.filter((e) => e.type === 'CALLS' && e.from === runSym?.id);
      expect(calls.some((e) => e.to === classSym?.id && e.resolution === 'resolved')).toBe(true);
      expect(calls.some((e) => e.to === processSym?.id && e.resolution === 'resolved')).toBe(true);
    });

    it('does not falsely resolve member calls to arbitrary local functions with the same name', async () => {
      const files = [
        {
          path: 'app.py',
          content: 'def get():\n    return "local get"\n\ndef handle(request):\n    return request.get("key")\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'py-no-false-pos', files });

      const localGet = result.nodes.find((n) => n.evidence?.name === 'get');
      const handleFunc = result.nodes.find((n) => n.evidence?.name === 'handle');

      // The call `request.get("key")` inside `handle` must NOT resolve to the unrelated `localGet`
      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === handleFunc?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).not.toBe(localGet?.id);
      expect(callEdge?.resolution).toBe('unresolved');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Go Fixtures                                                                */
  /* -------------------------------------------------------------------------- */
  describe('Go Resolution', () => {
    it('resolves cross-file calls within the same package directory without imports', async () => {
      const files = [
        { path: 'cmd/server/main.go', content: 'package main\n\nfunc main() {\n    InitConfig()\n}\n' },
        { path: 'cmd/server/config.go', content: 'package main\n\nfunc InitConfig() string {\n    return "dev"\n}\n' },
      ];
      const result = await analyzeRepository({ snapshotId: 'go-same-pkg', files });

      const mainSym = result.nodes.find((n) => n.evidence?.name === 'main');
      const configSym = result.nodes.find((n) => n.evidence?.name === 'InitConfig');
      expect(mainSym).toBeDefined();
      expect(configSym).toBeDefined();

      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === mainSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(configSym?.id);
      expect(callEdge?.resolution).toBe('resolved');
    });

    it('resolves cross-package calls mapped via go.mod module', async () => {
      const files = [
        { path: 'go.mod', content: 'module github.com/myorg/myapp\n\ngo 1.22\n' },
        {
          path: 'cmd/server/main.go',
          content: 'package main\n\nimport "github.com/myorg/myapp/pkg/auth"\n\nfunc Run() {\n    auth.Authenticate("token")\n}\n',
        },
        {
          path: 'pkg/auth/auth.go',
          content: 'package auth\n\nfunc Authenticate(t string) bool {\n    return true\n}\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'go-mod-1', files });

      const runSym = result.nodes.find((n) => n.evidence?.name === 'Run');
      const authSym = result.nodes.find((n) => n.evidence?.name === 'Authenticate');
      expect(runSym).toBeDefined();
      expect(authSym).toBeDefined();

      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === runSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(authSym?.id);
      expect(callEdge?.resolution).toBe('resolved');
    });

    it('isolates packages with the same name in different directories without collision', async () => {
      const files = [
        { path: 'go.mod', content: 'module myapp\n' },
        { path: 'pkg/auth/utils/helper.go', content: 'package utils\nfunc Helper() int { return 1 }\n' },
        { path: 'pkg/db/utils/helper.go', content: 'package utils\nfunc Helper() string { return "db" }\n' },
        {
          path: 'cmd/main.go',
          content: 'package main\nimport authUtils "myapp/pkg/auth/utils"\nfunc Call() {\n    authUtils.Helper()\n}\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'go-collision-free', files });

      const authHelper = result.nodes.find((n) => n.evidence?.name === 'Helper' && n.evidence?.path === 'pkg/auth/utils/helper.go');
      const dbHelper = result.nodes.find((n) => n.evidence?.name === 'Helper' && n.evidence?.path === 'pkg/db/utils/helper.go');
      const callSym = result.nodes.find((n) => n.evidence?.name === 'Call');

      expect(authHelper).toBeDefined();
      expect(dbHelper).toBeDefined();
      expect(authHelper?.id).not.toBe(dbHelper?.id);

      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === callSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(authHelper?.id);
      expect(callEdge?.resolution).toBe('resolved');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Rust Fixtures                                                              */
  /* -------------------------------------------------------------------------- */
  describe('Rust Resolution', () => {
    it('resolves cross-file calls using mod and use declarations', async () => {
      const files = [
        {
          path: 'src/main.rs',
          content: 'mod helpers;\nuse helpers::calculate;\n\nfn main() {\n    calculate(5);\n}\n',
        },
        {
          path: 'src/helpers.rs',
          content: 'pub fn calculate(n: i32) -> i32 {\n    n * 2\n}\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'rs-cross-1', files });

      const mainSym = result.nodes.find((n) => n.evidence?.name === 'main');
      const calcSym = result.nodes.find((n) => n.evidence?.name === 'calculate');
      expect(mainSym).toBeDefined();
      expect(calcSym).toBeDefined();

      const callEdge = result.edges.find((e) => e.type === 'CALLS' && e.from === mainSym?.id);
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toBe(calcSym?.id);
      expect(callEdge?.resolution).toBe('resolved');
    });

    it('resolves cross-file trait implementations', async () => {
      const files = [
        {
          path: 'src/lib.rs',
          content: 'pub mod traits;\npub mod server;\n',
        },
        {
          path: 'src/traits.rs',
          content: 'pub trait Handler {\n    fn handle(&self) -> bool;\n}\n',
        },
        {
          path: 'src/server.rs',
          content: 'use crate::traits::Handler;\n\npub struct Server;\n\nimpl Handler for Server {\n    fn handle(&self) -> bool {\n        true\n    }\n}\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'rs-trait-1', files });

      const serverSym = result.nodes.find((n) => n.evidence?.name === 'Server');
      const traitSym = result.nodes.find((n) => n.evidence?.name === 'Handler');
      expect(serverSym).toBeDefined();
      expect(traitSym).toBeDefined();

      const implEdge = result.edges.find((e) => e.type === 'IMPLEMENTS');
      expect(implEdge).toBeDefined();
      expect(implEdge?.from).toBe(serverSym?.id);
      expect(implEdge?.to).toBe(traitSym?.id);
      expect(implEdge?.resolution).toBe('resolved');
    });

    it('resolves associated functions (constructors) and methods on instantiated structs', async () => {
      const files = [
        {
          path: 'src/main.rs',
          content: 'pub struct Worker;\n\nimpl Worker {\n    pub fn new() -> Self {\n        Worker\n    }\n    pub fn work(&self) {}\n}\n\nfn run() {\n    let w = Worker::new();\n    w.work();\n}\n',
        },
      ];
      const result = await analyzeRepository({ snapshotId: 'rs-assoc-1', files });

      const runSym = result.nodes.find((n) => n.evidence?.name === 'run');
      const newSym = result.nodes.find((n) => n.evidence?.name === 'Worker::new');
      const workSym = result.nodes.find((n) => n.evidence?.name === 'Worker::work');

      expect(runSym).toBeDefined();
      expect(newSym).toBeDefined();
      expect(workSym).toBeDefined();

      const callsFromRun = result.edges.filter((e) => e.type === 'CALLS' && e.from === runSym?.id);
      expect(callsFromRun.some((e) => e.to === newSym?.id && e.resolution === 'resolved')).toBe(true);
      expect(callsFromRun.some((e) => e.to === workSym?.id && e.resolution === 'resolved')).toBe(true);
    });
  });
});
