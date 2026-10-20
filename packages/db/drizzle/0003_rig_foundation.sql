CREATE TYPE "analysis_status" AS ENUM ('queued', 'running', 'completed', 'partial', 'failed');
ALTER TYPE "job_stage" ADD VALUE 'analysis';
CREATE TABLE "analysis_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "snapshot_id" uuid NOT NULL REFERENCES "snapshots"("id"),
  "analyzer_version" text NOT NULL,
  "schema_version" text NOT NULL,
  "status" "analysis_status" NOT NULL DEFAULT 'queued',
  "progress" integer NOT NULL DEFAULT 0,
  "diagnostics" jsonb,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "analysis_runs_identity_idx" ON "analysis_runs" ("snapshot_id", "analyzer_version", "schema_version");
CREATE INDEX "analysis_runs_status_idx" ON "analysis_runs" ("status");
CREATE TABLE "graph_nodes" (
  "id" text PRIMARY KEY,
  "snapshot_id" uuid NOT NULL REFERENCES "snapshots"("id"),
  "analyzer_version" text NOT NULL,
  "schema_version" text NOT NULL,
  "node_type" text NOT NULL,
  "node_key" text NOT NULL,
  "evidence" jsonb
);
CREATE INDEX "graph_nodes_snapshot_idx" ON "graph_nodes" ("snapshot_id");
CREATE UNIQUE INDEX "graph_nodes_snapshot_key_idx" ON "graph_nodes" ("snapshot_id", "analyzer_version", "schema_version", "node_key");
CREATE TABLE "graph_edges" (
  "id" text PRIMARY KEY,
  "snapshot_id" uuid NOT NULL REFERENCES "snapshots"("id"),
  "analyzer_version" text NOT NULL,
  "schema_version" text NOT NULL,
  "edge_type" text NOT NULL,
  "from_node_id" text NOT NULL,
  "to_node_id" text NOT NULL,
  "resolution" text NOT NULL,
  "evidence" jsonb
);
CREATE INDEX "graph_edges_snapshot_idx" ON "graph_edges" ("snapshot_id");
CREATE UNIQUE INDEX "graph_edges_snapshot_key_idx" ON "graph_edges" ("snapshot_id", "analyzer_version", "schema_version", "edge_type", "from_node_id", "to_node_id", "id");
