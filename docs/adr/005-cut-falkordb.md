# ADR 005 — Cut FalkorDB; use Postgres tables for the graph

- **Status:** accepted (supersedes ULTRAPLAN v1's B.3)
- **Date:** 2026-04-25
- **Deciders:** core
- **Context tag:** architecture, graph, storage

## Context

The original ULTRAPLAN (v1) had B.3 as "FalkorDB temporal graph
adapter". On revisiting: the GKS workload is really shallow BFS +
bi-temporal `asOf` queries at ≤ 10M edges; we don't need a dedicated
graph engine.

## Decision

**Cut FalkorDB.** Implement the graph backend as two Postgres tables
(`gks_graph_node`, `gks_graph_edge`) sharing the same `pg.Pool` as
pgvector. Keep `GraphBackend` interface (ADR 003) so a future engine
can drop in if we ever need one.

Provide an alternative embedded option (`KuzuGraphBackend`) for users
who don't want Postgres — currently planned but not implemented; the
in-process `GraphStore` with JSONL persistence covers the no-Postgres
case for now.

## Reasons we passed on each option

| Engine | Why not |
|---|---|
| **FalkorDB** | SSPL license blocks SaaS use; no native bi-temporal support; requires a separate Redis-protocol service. |
| **Neo4j** | Overkill for ≤ 10M edges; AGPL/commercial licence drama; heavy ops surface. |
| **Apache AGE** | Postgres extension, but version-conflict-prone alongside pgvector in the wild. |
| **TigerGraph / Memgraph / ArangoDB** | All overkill for embedded use; commercial / paid tiers. |

## Reasons Postgres tables won

- Free if pgvector lands first (B.1 → B.3a in our sequence). One
  service to operate.
- Bi-temporal as a `tstzrange(valid_from, COALESCE(valid_to, 'infinity'))`
  GiST index — fast for `asOf` queries.
- BFS as a recursive CTE. Within an order of magnitude of dedicated
  graph engines for shallow walks.
- Transactional consistency with vector data (supersede flips both at
  once).
- PostgreSQL licence is permissive.

## Consequences

**Positive**
- Cut a dep, an ops service, and an SSPL licence concern from the
  critical path.
- `B.3a` shipped in 1.5 days vs. ~2-3 estimated for FalkorDB.
- Tests use a mock `pg.Pool` + assertion against generated SQL — fast
  and deterministic.

**Negative**
- We're betting that depth ≤ 4 BFS is enough for the foreseeable
  future. If usage grows toward depth-10 walks, recursive CTE
  performance will degrade and we'll revisit (Kuzu likely).

## References

- [`docs/ULTRAPLAN.md`](../ULTRAPLAN.md) — Phase 2B B.3a
- `src/memory/graph/pg.ts` — `PgGraphBackend`
- `src/memory/graph/pg.sql` — schema with GiST + partial indexes
