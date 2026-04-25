-- GKS v3 — Postgres graph backend schema (bi-temporal).
--
-- Sister schema to pgvector.sql. Run via the same npm run pg-migrate runner
-- with --schema=graph (or apply both with --schema=all).
--
-- Design choices
--   * Two tables: graph_node + graph_edge. No Apache AGE / no Cypher — straight
--     relational with recursive CTE for traversal. Fast at ≤ 10M edges.
--   * Bi-temporal valid_from / valid_to live on edges only (nodes are usually
--     atemporal labels). asOf queries use a GiST index on
--     tstzrange(valid_from, valid_to) for sub-millisecond range membership.
--   * `superseded_by` is a self-FK (NULL = current edge); flipped by
--     supersede() to maintain audit trail.
--   * Per-instance scoping uses the same {{table}} convention as pgvector.sql.
--     Default: gks_graph (so nodes live in gks_graph_node, edges in
--     gks_graph_edge).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── nodes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "{{table}}_node" (
  id            text PRIMARY KEY,
  labels        text[] NOT NULL DEFAULT '{}',
  props         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "{{table}}_node_labels_idx"
  ON "{{table}}_node" USING gin (labels);

-- ─── edges ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "{{table}}_edge" (
  id            text PRIMARY KEY,
  from_node     text NOT NULL REFERENCES "{{table}}_node"(id) ON DELETE RESTRICT,
  to_node       text NOT NULL REFERENCES "{{table}}_node"(id) ON DELETE RESTRICT,
  rel           text NOT NULL,
  props         jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,                              -- NULL = currently valid
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  superseded_by text REFERENCES "{{table}}_edge"(id) ON DELETE SET NULL
);

-- Common-case indexes: outbound + inbound traversal, relation filter.
CREATE INDEX IF NOT EXISTS "{{table}}_edge_from_rel_idx"
  ON "{{table}}_edge" (from_node, rel);

CREATE INDEX IF NOT EXISTS "{{table}}_edge_to_rel_idx"
  ON "{{table}}_edge" (to_node, rel);

-- Bi-temporal: GiST range index. Use the half-open interval
-- [valid_from, COALESCE(valid_to, 'infinity')) so asOf queries reduce to
-- a containment check.
CREATE INDEX IF NOT EXISTS "{{table}}_edge_valid_idx"
  ON "{{table}}_edge"
  USING gist (tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)'));

-- Partial index for the "currently valid" hot path.
CREATE INDEX IF NOT EXISTS "{{table}}_edge_active_idx"
  ON "{{table}}_edge" (from_node, rel)
  WHERE valid_to IS NULL;
