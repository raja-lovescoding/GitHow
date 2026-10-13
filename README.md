# GitHow Phase 2

This repository contains the durable ingestion and Phase 3 repository-intelligence foundation for the GitHow platform. It implements public repository URL entry, immutable GitHub commit resolution, safe tarball manifesting, PostgreSQL persistence, pg-boss jobs, S3-compatible archive/manifest storage, and deterministic TypeScript/JavaScript graph extraction.

## Structure

- `apps/web`: Next.js homepage and `/{owner}/{repo}` repository experience.
- `apps/api`: Fastify REST API for submission and polling.
- `apps/worker`: pg-boss worker that downloads, inventories, stores, and finalizes ingestion jobs.
- `packages/core`: URL rules and shared Zod/domain contracts.
- `packages/github`: public GitHub metadata and commit/archive access.
- `packages/ingest`: bounded, path-safe manifest generation.
- `packages/db`: Drizzle PostgreSQL schema and migrations.
- `packages/storage`: S3-compatible object storage adapter used by the worker.
- `packages/analyzer`: syntax-tree-based TypeScript/JavaScript extraction and versioned RIG model.
- `packages/config`: environment validation.
- `infra`: local PostgreSQL and MinIO Compose services.

Reserved product paths include `/about`, `/pricing`, `/docs`, `/api`, `/_next`, `/_auth`, and `/_share`. Other two-segment paths are treated as repository routes and must match GitHub naming rules.

## Local setup

Requirements: Node 22+, pnpm 10+, and Docker Desktop.

```powershell
pnpm install
Copy-Item .env.example .env
pnpm infra:up
pnpm db:migrate
```

Run the development processes in separate terminals:

```powershell
pnpm --filter @gitflow/api dev
pnpm --filter @gitflow/worker dev
pnpm --filter @gitflow/web dev
```

Open `http://localhost:3000` or a direct repository such as `http://localhost:3000/facebook/react`. The API is at `http://localhost:4000`; PostgreSQL is exposed on `localhost:5433`; local S3-compatible object storage is at `http://localhost:9001`.

## Checks

```powershell
pnpm test
pnpm typecheck
pnpm build
```

Tests use mocked GitHub responses and deterministic tar fixtures. Set `INTEGRATION=1` to run the PostgreSQL and MinIO tests after Docker services are healthy. No GitHub token is required for unit tests; set `GITHUB_TOKEN` in `.env` for better GitHub API rate limits during manual use.

## Durable ingestion flow

The API resolves metadata and SHA, transactionally upserts the repository/snapshot/job, and publishes a validated `repository-ingestion` pg-boss message. The worker consumes it, downloads the SHA-pinned archive, applies manifest safety limits, uploads `archive.tar.gz` and `manifest.json` under an immutable SHA/analyzer key, and marks the database rows ready. It then creates one `repository-analysis` job per snapshot/version. The analysis worker verifies the stored manifest against the archive, extracts only supported source files, parses them without executing repository code, and transactionally replaces that version's graph records. Failed jobs clean up uploaded objects and retry transient failures; terminal failures and parse diagnostics remain visible through polling.

For real local verification, ensure Docker Desktop's Linux engine is running, then run `pnpm infra:up`, `pnpm db:migrate`, and `INTEGRATION=1 pnpm test`. Start API, worker, and web in separate terminals. The worker creates the configured object-storage bucket on startup. The Compose service uses RustFS because the `minio/minio` Docker Hub repository is no longer available; RustFS provides the same S3-compatible API used by the application.

## Phase 3 analysis foundation

The analyzer consumes an immutable snapshot identity and supported source files, parses them with the TypeScript compiler AST (without executing repository code), and emits sorted, content-addressed nodes and edges with one-based source evidence. The parser-specific work is kept behind the analyzer boundary so a future parser can be evaluated without changing the graph model or persistence contracts. For the current TypeScript/JavaScript scope, the compiler AST is the approved parser decision; Tree-sitter is deferred until multi-language support or parser portability justifies the migration cost. It currently covers declarations, classes and basic heritage, ES imports/exports, relative extension and `index` resolution, and conservative direct calls. Parse diagnostics are retained as partial results. Dynamic imports, computed properties, type inference, complex re-exports, decorators, generated code, and framework conventions remain explicit limitations.

Graph records are persisted in `analysis_runs`, `graph_nodes`, and `graph_edges`; `packages/db/drizzle/0003_rig_foundation.sql` is the migration. IDs are SHA-256 hashes of the graph schema version, snapshot ID, record type, stable key, and (for edges) source evidence, so processing order and local filesystem paths cannot change them. The API exposes bounded graph reads at `GET /snapshots/:id/graph?limit=500`.

### GitFlow application flows

The analyzer recognizes source-backed Express entrypoints when it sees an Express import or `require` and a receiver created by `express()` or `express.Router()`. Supported registrations are `get`, `post`, `put`, `patch`, `delete`, `all`, and `use`, including literal or top-level string constants, route-level middleware, named local handlers, and inline callbacks. Each route, middleware association, and handler relationship is persisted in the same RIG with source evidence and a resolution status.

`GET /snapshots/:id/flows` lists deterministic route candidates from that immutable snapshot. `GET /snapshots/:id/flows/:flow-id` assembles a bounded flow by following ordered route relationships and resolved `CALLS` edges. The web explorer lets users select an entrypoint and source-backed step. `observed` means a construct was directly found in source, `resolved` means a target declaration was linked, and `unresolved` means a plausible target could not be linked.

Static analysis does not execute repositories or prove runtime order. Dynamic route registration, nested cross-file mount-prefix composition, reflection, dependency injection, conditional behavior, and framework adapters other than Express remain unsupported or explicitly unresolved. Traversal is bounded to eight call levels, six outgoing relationships per node, and eighty steps.

### Phase 3 acceptance checklist

After `pnpm infra:up` and `pnpm db:migrate`, start the API, worker, and web processes in separate terminals with the commands above. Submit a small public GitHub TypeScript/JavaScript repository to `POST http://localhost:4000/repos` using `{"url":"https://github.com/owner/repo"}`. Poll the returned snapshot with `GET /repos/:owner/:repo` until the ingestion job is `completed` and the snapshot is `ready`, then poll `GET /snapshots/:snapshot-id/analysis` until it is `completed`. Retrieve bounded results with `GET /snapshots/:snapshot-id/graph?limit=500` and confirm non-zero source-backed nodes and edges. Repeat the repository submission to verify reuse, restart the API and worker, and confirm the completed analysis and graph remain available. For retry behavior, use the deterministic malformed-archive and extraction-failure fixtures covered by the worker/integration tests; never execute code from the analyzed repository.

## Product naming

The public display name is controlled by `NEXT_PUBLIC_PRODUCT_NAME` and defaults to `GitHow`. Technical package names, queue names, table names, and analyzer contracts intentionally remain stable identifiers. This keeps a future GitFlow/GitHow rename to a branding/configuration change rather than a storage or migration rewrite.
