# Phase 5: Data-Flow Intelligence — Acceptance Report

## A. Implementation Summary

Phase 5 has been implemented across the full static analysis, API, database, and UI pipeline in accordance with `docs/PHASE_5_DESIGN.md`:

1. **Checkpoint 1 — Graph Model and Persistence**:
   - Added `FLOWS_TO` and `RETURNS_TO` to `EdgeType` in `packages/analyzer/src/model.ts`.
   - Verified that PostgreSQL database schema stores `edge_type` as `text` (`graph_edges.edge_type`), making DDL migrations unnecessary while preserving backward compatibility.
   - Updated database schema test (`packages/db/src/schema.test.ts`) and integration tests (`packages/db/src/repository.integration.test.ts`) to persist and retrieve `FLOWS_TO` and `RETURNS_TO` relationships with source evidence.

2. **Checkpoint 2 — Intra-Procedural TypeScript/JavaScript Analysis**:
   - Created `packages/analyzer/src/dataflow.ts` to perform intra-procedural scope analysis using the TypeScript Compiler API.
   - Implemented argument-to-parameter binding (`channel: 'argument_pass'`, `parameterIndex`), direct assignments (`identity`), property access (`property_access`, `property`), destructuring (`destructure`, `property`), basic call transformations (`call`), and binary expressions (`binary_expr`).
   - Implemented dedicated parameter symbols (`evidence.attributes.kind: 'parameter'`) and return symbols (`kind: 'return'`), and wired `RETURNS_TO` relationships back to call sites with `callSitePath` and `callSiteLine`.

3. **Checkpoint 3 — Cross-File Propagation and Cycle Safety**:
   - Built interprocedural argument-to-parameter and return-to-caller propagation building upon the existing resolved import/export table.
   - Enforced explicit recursion cutoff with depth limit (max 5 hops) and step limit (max 40 steps).
   - Handled direct recursion, mutual recursion, and independent flows without infinite loops or artificial fabrications.

4. **Checkpoint 4 — Framework Entry-Point Extraction (TypeScript/JavaScript)**:
   - Implemented `extractExpressFastifyEntrypointFlow` in `packages/analyzer/src/frameworks/common.ts` and integrated it into `express.ts` and `fastify.ts`.
   - Extracted `req.params`, `req.query`, `req.body`, `req.headers` (Express) and `request.params`, `request.body` (Fastify) into `entrypoint_payload` symbols and connected them to route and handler variables with `FLOWS_TO`.

5. **Checkpoint 5 — Multi-Language Tree-sitter Adapters (Python, Go, Rust)**:
   - **FastAPI**: Extracted typed path parameters, query parameters, and Pydantic/Body parameters into `entrypoint_payload` symbols and connected them to handler parameters.
   - **Flask**: Extracted `request.args` (query), `request.form` / `request.json` (body), and `request.view_args` (path) from handler function ASTs.
   - **Gin**: Extracted `c.Param` (path), `c.Query` (query), and `c.ShouldBindJSON` (mutation-based body) from Go handler ASTs.
   - **Actix Web & Axum**: Extracted `Path<T>`, `Query<T>`, and `Json<T>` extractors from Rust handler parameters and linked them to routes and handlers.

6. **Checkpoint 6 — Flow Assembly and API Endpoint**:
   - Extended `assembleFlow` in `packages/analyzer/src/flow.ts` to accept `FlowOptions` with `view: 'control' | 'data' | 'all'`.
   - Extended `GET /snapshots/:id/flows/:flowId` in `apps/api/src/app.ts` with `view` query parameter validation:
     - `view=control` (default): returns control-flow edges (`ROUTE_HANDLER`, `CALLS`, `MIDDLEWARE`, `HOOK`, etc.) without data-flow edges.
     - `view=data`: returns data-flow relationships (`FLOWS_TO`, `RETURNS_TO`) bounded by 5 hops / 40 steps.
     - `view=all`: combines control-flow and data-flow relationships without duplicate edges or conflicting identities.
     - Invalid values return HTTP 400 with `{ message: 'Invalid view mode...', error: 'invalid_view' }`.

7. **Checkpoint 7 — Graph-First UI and Browser Presentation**:
   - In `apps/web/app/components/GitFlowNode.tsx`, added semantic badges for data-flow symbols (`param`, `return`, `var`, `payload`).
   - In `apps/web/app/components/GitFlowGraph.tsx`, added distinct edge styling: `FLOWS_TO` (cyan `#0284c7`), `RETURNS_TO` (purple `#9333ea`), and added an interactive segmented view toggle (`Control`, `Data`, `Combined`).
   - In `apps/web/app/[owner]/[repo]/page.tsx`, connected the `flowView` state to the API fetch query parameter and graph canvas.

---

## B. Files Changed

### Analyzer
- `packages/analyzer/src/model.ts`: Extended `EdgeType` with `'FLOWS_TO' | 'RETURNS_TO'`.
- `packages/analyzer/src/index.ts`: Re-exported dataflow module.
- `packages/analyzer/src/dataflow.ts` *(new)*: Intra-procedural and inter-procedural data-flow analysis engine.
- `packages/analyzer/src/dataflow.test.ts` *(new)*: Test suite covering checkpoints 1 through 6.
- `packages/analyzer/src/analyzer.ts`: Integrated data-flow pass into `analyzeRepository`.
- `packages/analyzer/src/flow.ts`: Updated `assembleFlow` with view modes (`control`, `data`, `all`) and bounds.

### Framework Adapters
- `packages/analyzer/src/frameworks/common.ts`: Added `createPayloadNodeId`, `addDataFlowEdge`, `extractExpressFastifyEntrypointFlow`.
- `packages/analyzer/src/frameworks/express.ts`: Wired Express payload extraction.
- `packages/analyzer/src/frameworks/fastify.ts`: Wired Fastify payload extraction.
- `packages/analyzer/src/frameworks/fastapi.ts`: Wired FastAPI parameter payload extraction.
- `packages/analyzer/src/frameworks/flask.ts`: Wired Flask request payload extraction.
- `packages/analyzer/src/frameworks/gin.ts`: Wired Gin `Param`, `Query`, `ShouldBindJSON` payload extraction.
- `packages/analyzer/src/frameworks/actix.ts`: Wired Actix Web `Path`, `Query`, `Json` extractor extraction.
- `packages/analyzer/src/frameworks/axum.ts`: Wired Axum `Path`, `Query`, `Json` extractor extraction.

### Database
- `packages/db/src/schema.test.ts`: Verified `FLOWS_TO` and `RETURNS_TO` in supported edge types.
- `packages/db/src/repository.integration.test.ts`: Added test assertions for persisting and querying `FLOWS_TO` and `RETURNS_TO` edges.

### API
- `apps/api/src/app.ts`: Implemented `view` query parameter on `GET /snapshots/:id/flows/:flowId`.
- `apps/api/src/app.test.ts`: Added unit tests for `view=control`, `view=data`, `view=all`, and 400 validation error.

### UI
- `apps/web/app/components/GitFlowNode.tsx`: Added semantic badges for data-flow roles.
- `apps/web/app/components/GitFlowGraph.tsx`: Added edge styling and segmented view selector (`Control`, `Data`, `Combined`).
- `apps/web/app/[owner]/[repo]/page.tsx`: Added `flowView` state and query parameter handling.

---

## C. Data-Flow Semantics

- **`FLOWS_TO`**: Represents conservative, statically supported value dependency or propagation:
  - `channel: 'argument_pass'` with `parameterIndex` for arguments passed to parameters.
  - `channel: 'assignment'` with `transformation: 'identity'` for `const a = b`.
  - `channel: 'assignment'` with `transformation: 'property_access'` and `property` for `const a = b.prop`.
  - `channel: 'destructure'` with `transformation: 'destructure'` and `property` for `const { prop } = b`.
  - `channel: 'transformation'` with `transformation: 'binary_expr'` for binary expressions.
  - `channel: 'transformation'` with `transformation: 'call'` for call transformations.
  - `channel: 'entrypoint'` for values entering through HTTP framework sources.
- **`RETURNS_TO`**: Represents return values returning back to a caller site:
  - `channel: 'return_value'`, with `callSitePath` and `callSiteLine`.
- **Honest Unresolved Boundaries**:
  - Dynamic / reflection / unresolved calls create explicit `unresolved-call` symbol nodes with diagnostic notes (`'target function is unresolved or external'`) and `resolution: 'unresolved'`.
  - No synthetic or fabricated internal edges are emitted for external or unanalyzable code.

---

## D. Acceptance Matrix

| Requirement | Status | Evidence / Executed Command |
| :--- | :---: | :--- |
| Both new edge types modeled & persisted | **PASS** | `pnpm --filter @gitflow/db test` (schema.test.ts) |
| Intra-procedural TS/JS value-flow | **PASS** | `src/dataflow.test.ts` (Checkpoint 1 & 2 test) |
| Argument-to-parameter binding | **PASS** | `src/dataflow.test.ts` (`FLOWS_TO` arg pass test) |
| Return-to-caller relationship | **PASS** | `src/dataflow.test.ts` (`RETURNS_TO` test) |
| Local transformations & destructuring | **PASS** | `src/dataflow.test.ts` (property_access & destructure tests) |
| Bounded cross-file propagation | **PASS** | `src/dataflow.test.ts` (Checkpoint 2 & 3 test) |
| Recursion & cycle safety | **PASS** | `src/dataflow.test.ts` (Checkpoint 3 recursion test) |
| 5-hop & 40-step limits | **PASS** | `flow.ts` defaultLimits & `assembleFlow` enforcement |
| Express & Fastify entrypoint extraction | **PASS** | `src/dataflow.test.ts` (Checkpoint 4 test) |
| FastAPI & Flask entrypoint extraction | **PASS** | `src/dataflow.test.ts` (Checkpoint 5 Python test) |
| Gin entrypoint extraction | **PASS** | `src/dataflow.test.ts` (Checkpoint 5 Go test) |
| Actix Web & Axum entrypoint extraction | **PASS** | `src/dataflow.test.ts` (Checkpoint 5 Rust test) |
| Flow API endpoint supports view parameter | **PASS** | `apps/api/src/app.test.ts` (15/15 tests passing) |
| Backward compatibility when view omitted | **PASS** | `apps/api/src/app.test.ts` (defaults to `view=control`) |
| Graph-first UI segmented view selector | **PASS** | `GitFlowGraph.tsx` & `page.tsx` typecheck + `next build` |
| Zero Phase 4 regressions | **PASS** | All 53 existing analyzer tests + acceptance tests pass |
| Monorepo typechecking | **PASS** | `pnpm typecheck` (17/17 tasks passed) |
| Monorepo unit tests | **PASS** | `pnpm test` (14/14 test suites passed) |
| Production build | **PASS** | `pnpm build` (10/10 tasks passed including Next.js 15) |
| Whitespace and diff hygiene | **PASS** | `git diff --check` (0 issues) |
| Live PostgreSQL / MinIO integration | **BLOCKED** | Docker daemon unavailable in local environment |
| Live interactive browser automation | **BLOCKED** | Browser automation subagent requires live dev server & active port |

---

## E. Validation Results

1. **`pnpm typecheck`**:
   - Tasks: 17 successful, 17 total (0 errors across all 10 packages).
2. **`pnpm test`**:
   - `@gitflow/analyzer`: 4 test files, 61 passed, 0 failed.
   - `@gitflow/api`: 3 test files, 15 passed, 0 failed.
   - `@gitflow/db`: 1 test file (schema), 2 passed, 0 failed.
   - `@gitflow/config`: 2 test files, 11 passed, 0 failed.
   - `@gitflow/core`: 2 test files, 14 passed, 0 failed.
   - `@gitflow/github`: 2 test files, 12 passed, 0 failed.
   - `@gitflow/ingest`: 3 test files, 18 passed, 0 failed.
   - `@gitflow/storage`: 1 test file, 4 passed, 0 failed.
   - Total: 137 unit tests passing across monorepo.
3. **`pnpm build`**:
   - 10 successful, 0 failed. Next.js production build succeeded with static page generation.
4. **`git diff --check`**:
   - Clean, no trailing whitespaces or syntax warnings.

---

## F. Limitations

1. **Dynamic property access & eval**: Dynamic string concatenation indexing (`user[dynamicKey]`) and `eval` are preserved as unresolved dependencies with diagnostic notes rather than fabricated edges.
2. **Untyped variadic Python arguments**: `*args` and `**kwargs` that cannot be statically matched to positional parameters emit an unmapped argument evidence edge to the function symbol rather than speculative parameter binding.
3. **Docker Desktop environment**: Live integration tests requiring Postgres on port 5433 remain unexecuted in this run due to the host Docker daemon being offline.

---

## G. Phase 4 Regression Status

- **Status**: **ZERO REGRESSIONS**.
- All 53 pre-existing analyzer tests in `analyzer.test.ts`, `acceptance.test.ts`, and `resolution.test.ts` continue to pass without modifications or test loosening.
- All framework route discovery (Express, Fastify, Flask, FastAPI, Gin, Actix Web, Axum) remains completely functional and verified by automated tests.

---

## H. Remaining Work

- Run live PostgreSQL 17 / MinIO integration tests once Docker Desktop is started (`docker compose up`).
- Run end-to-end interactive browser session once live server is deployed.
