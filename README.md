# GitFlow Phase 1

This repository contains the Phase 1 foundation for the GitFlow, GitExplain, and GitTime platform. It currently implements the public repository entry flow, immutable GitHub commit resolution, safe tarball manifesting, API contracts, and the initial database schema. AST analysis, the RIG, flow discovery, private repositories, and AI explanations are deliberately later phases.

## Structure

- `apps/web`: Next.js homepage and `/{owner}/{repo}` repository experience.
- `apps/api`: Fastify REST API for submission and polling.
- `apps/worker`: pg-boss worker boundary for repository jobs.
- `packages/core`: URL rules and shared Zod/domain contracts.
- `packages/github`: public GitHub metadata and commit/archive access.
- `packages/ingest`: bounded, path-safe manifest generation.
- `packages/db`: Drizzle PostgreSQL schema and migrations.
- `packages/config`: environment validation.
- `infra`: local PostgreSQL and MinIO Compose services.

Reserved product paths include `/about`, `/pricing`, `/docs`, `/api`, `/_next`, `/_auth`, and `/_share`. Other two-segment paths are treated as repository routes and must match GitHub naming rules.

## Local setup

Requirements: Node 22+, pnpm 10+, and Docker Desktop.

```powershell
pnpm install
Copy-Item .env.example .env
pnpm infra:up
pnpm db:generate
pnpm db:migrate
```

Run the development processes in separate terminals:

```powershell
pnpm --filter @gitflow/api dev
pnpm --filter @gitflow/worker dev
pnpm --filter @gitflow/web dev
```

Open `http://localhost:3000` or a direct repository such as `http://localhost:3000/facebook/react`. The API is at `http://localhost:4000`; MinIO is at `http://localhost:9001`.

## Checks

```powershell
pnpm test
pnpm typecheck
pnpm build
```

Tests use mocked GitHub responses and deterministic tar fixtures. No GitHub token is required for the unit and API contract tests. Set `GITHUB_TOKEN` in `.env` for better GitHub API rate limits during manual use.

## Phase 1 limitations

The Drizzle schema and pg-boss process are present, but the API's default test/local orchestration uses an in-memory adapter and the worker's queue handler is intentionally a boundary stub. A production completion pass must connect the API and worker to Drizzle transactions, pg-boss enqueue/claim, and an S3-compatible MinIO adapter before claiming durable archive storage and background processing are complete. Repository code is never executed.
