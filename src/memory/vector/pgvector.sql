-- GKS v3 — pgvector backend schema.
--
-- Designed to be re-runnable (idempotent) so npm run pg-migrate is safe to
-- call any number of times. All objects are namespaced under a configurable
-- table prefix (default: gks_vector) so you can run multiple GKS instances
-- in one DB.
--
-- HNSW index params per BGE-rerank docs default:
--   m = 16            (graph connectivity)
--   ef_construction = 64 (build-time accuracy)
--   ef_search = 40    (query-time accuracy; set per-session via SET hnsw.ef_search)
--
-- Run with: npm run pg-migrate
--
-- Template placeholders ({{table}}, {{dim}}) are substituted by the
-- migration runner. Identifiers are double-quoted in this file so that
-- the substitution can use bare identifiers (avoiding `"foo"_suffix` =
-- invalid Postgres syntax issues).

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── docs table ───────────────────────────────────────────────────────────
-- One row per stored chunk. The `vector` column dimension is template-
-- substituted by the migration runner (so the same schema can serve
-- bge-m3 = 1024 or text-embedding-3-small = 1536).
CREATE TABLE IF NOT EXISTS "{{table}}" (
  id           text PRIMARY KEY,
  store        text NOT NULL,                  -- 'atomic' | 'episodic' | ...
  source       text NOT NULL,
  chunk_id     text NOT NULL,
  text         text NOT NULL,
  vector       vector({{dim}}) NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Per-store partition for multi-tenant scoping (atomic vs episodic vs custom).
CREATE INDEX IF NOT EXISTS "{{table}}_store_idx" ON "{{table}}" (store);

-- HNSW index on the cosine-distance operator (vector_cosine_ops).
-- Note: HNSW indexes can take a while to build on large stores; the WITH
-- clause sets the build-time params.
CREATE INDEX IF NOT EXISTS "{{table}}_vector_hnsw_idx"
  ON "{{table}}" USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Bi-temporal index for `valid_to is null` queries (the common case).
-- Partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS "{{table}}_valid_active_idx"
  ON "{{table}}" ((metadata->>'session_id'))
  WHERE (metadata->>'valid_to') IS NULL;

-- ─── manifest table ───────────────────────────────────────────────────────
-- One row per (store) holding embedder model + dimension + file_hashes.
-- Mirrors the JSONL backend's _manifest.json.
CREATE TABLE IF NOT EXISTS "{{table}}_manifest" (
  store              text PRIMARY KEY,
  embedder_model     text NOT NULL,
  dimension          int  NOT NULL,
  doc_count          int  NOT NULL DEFAULT 0,
  last_updated       timestamptz NOT NULL DEFAULT now(),
  file_hashes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version     int  NOT NULL DEFAULT 1
);
