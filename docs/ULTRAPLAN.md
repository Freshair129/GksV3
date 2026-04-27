# GKS v3 — Ultraplan (Roadmap to SOTA Production)

**Document version:** v2 (FalkorDB → Postgres tables)
**Repo state at writing:** PR #1 `claude/build-gks-v3-W8a7V` — 17 commits, 96/96 tests, CI green
**Reference spec:** `BLUEPRINT--memory` (EVA Tri-Brain architecture)

---

## Where we are

Phase 1 + Phase 2 Slices A, C, D + simplify cleanup are done. The current
branch ships:

- **All 4 memory layers** wired into `retrieve()`: Atomic (exact ID), Vector
  (semantic), Obsidian (graph + fulltext), Episodic (session)
- **Pluggable backends** at every external boundary: `VectorBackend`,
  `GraphBackend`, `Reranker`, `LlmClient`, `ObsidianAdapter`
- **Bi-temporal `Retain`** with conflict resolution (`auto` / `supersede` /
  `coexist` policies)
- **Three benchmark runners**: LoCoMo, LongMemEval, BEAM — all runnable
  offline against tiny fixtures
- **Session lifecycle hooks** (`startSession` / `endSession`) per BLUEPRINT
  `init_sequence`
- **Incremental re-embed script** with manifest-driven `file_hashes`
- **96/96 tests** passing on Node 20 + 22 in CI

What's missing to call this **production-grade SOTA**:
1. Real infra adapters (currently file-based defaults only)
2. Real-scale benchmark numbers against full HF datasets
3. Production hardening (observability, resilience, multi-tenancy)
4. Developer experience polish (MCP server, CLI, ADRs)
5. Release engineering (semver, changelog, npm publish)

---

## Phase 2B — Infra Adapters

Each item is a self-contained backend that drops into an existing interface.
All five can run in parallel; the only ordering constraint is **B.3a depends
on B.1** (shared Postgres connection).

### B.1 — pgvector backend `~2d`

**Goal.** Replace the JSONL `VectorStore` for production-scale ingestion.

- Implement `PgvectorBackend implements VectorBackend` in
  `src/memory/vector/pgvector.ts`
- Schema migration: `CREATE EXTENSION vector; CREATE TABLE vector_doc(...);`
  with HNSW index using `vector_cosine_ops`
- Tuning: `m=16 ef_construction=64 ef_search=40` (BGE-rerank docs default)
- Batch upsert via Postgres `COPY` (~10× faster than `INSERT` loop)
- Wire through `MemoryStoreOptions.vectorBackend` factory — zero changes to
  callers
- **Deps:** Postgres ≥ 14, pgvector ≥ 0.5

### B.2 — HNSW in-process backend `~1d`

**Goal.** Alternative to B.1 for users who don't want a Postgres dep.

- Implement `HnswBackend implements VectorBackend` using `hnswlib-node`
- Single binary file persistence (`.brain/.../vector/atomic.hnsw`)
- Same VectorBackend interface as JSONL/pgvector — interchangeable
- **Deps:** `hnswlib-node` npm package

### B.3a — Postgres graph backend `~1.5d` 🌟

**Goal.** Persistent temporal knowledge graph in the same DB as pgvector.

> **Was:** B.3 FalkorDB (cut). Reasons: SSPL license blocks SaaS use,
> no native bi-temporal support, requires running a separate Redis-protocol
> service.

- Implement `PgGraphBackend implements GraphBackend` in
  `src/memory/graph/pg.ts`
- Schema (2 tables):
  - `graph_node(id, labels text[], props jsonb)`
  - `graph_edge(id, from, to, rel, props jsonb, valid_from, valid_to,
    recorded_at, superseded_by)`
- Indexes:
  - GiST on `tstzrange(valid_from, COALESCE(valid_to, 'infinity'))` →
    fast `asOf` queries
  - btree on `(from, rel)` and `(to, rel)` → fast neighbor lookups
- BFS traversal via SQL recursive CTE
- Transactional consistency with pgvector — atomic supersede across both
  vector + graph in one statement
- **Deps:** B.1 (shares Postgres instance, halves ops surface)

### B.3b — Kuzu embedded graph backend `~2d` (alternative to B.3a)

**Goal.** Embedded Cypher graph DB for users without Postgres.

- Implement `KuzuGraphBackend implements GraphBackend`
- Single `.kuzu` file (like SQLite but for graphs), MIT license
- Real Cypher queries for `query` / `neighbors` / asOf filters
- Columnar storage, performs well on analytics-style workloads
- **Deps:** `kuzu` npm package

### B.4 — MCP-stdio transport for Obsidian `~2d`

**Goal.** Switch from REST plugin to the proper MCP-stdio transport per
BLUEPRINT spec.

- Implement `MCPObsidianAdapter implements ObsidianAdapter`
- Spawn `obsidian-mcp` server, JSON-RPC 2.0 over stdin/stdout
- Preserve the existing 120s TTL cache wrapper as-is
- REST adapter stays available for users who run the Local REST API plugin
- **Deps:** `@modelcontextprotocol/sdk`

### B.5 — Cross-encoder reranker fixtures `~0.5d`

**Goal.** Validate the existing HTTP reranker backend against a real service.

- docker-compose for `text-embeddings-inference` with `BAAI/bge-reranker-v2-m3`
- Integration test: rerank latency, score distribution, fallback on timeout
- HTTP backend already wired in `src/memory/rerank.ts` — only needs an
  endpoint to point at

---

## Phase 3 — Real-Scale Benchmark Sweep `~3-5d`

Targets are derived from the user spec (§5) and SOTA references
(ByteRover 2.0, EverOS).

### G3.1 — LoCoMo against full HuggingFace dataset

| Configuration | Expected | Target |
|---|---|---|
| bge-m3 + BM25 rerank | 80–85% evidence@5 | sanity floor |
| bge-m3 + BGE rerank-v2 | — | **≥ 92%** evidence@5 |

Sweep matrix: model × reranker × topK × threshold. JSON output for diffing.

### G3.2 — LongMemEval (full set)

Per-question-type breakdown. Temporal-reasoning is the hard one.

| Bucket | Target |
|---|---|
| Overall accuracy | **≥ 85%** |
| `temporal-reasoning` | **≥ 75%** |
| `multi-session` | **≥ 80%** |

### G3.3 — BEAM @ 10M tokens

Ingest a real corpus (Wikipedia subset). Measure:

| Metric | Target |
|---|---|
| `token_savings_pct` | **≥ 90%** (return ≤ 10% of corpus tokens per query) |
| `recall_p95_ms` | **< 200ms** |
| `ingest_throughput` | **> 100 docs/s** |

If using HNSW: also report an `ef_search` recall/latency curve.

### G3.4 — Reproducible benchmark report

- Single command: `make benchmarks` produces JSON + markdown summary
- Embedder model versions pinned in the manifest so historical numbers
  remain comparable

---

## Phase 4 — Production Hardening `~5-7d`

All five items are mostly parallel — the bottleneck is review, not
implementation.

### H.1 — Observability `~2d`

- OpenTelemetry traces on `retrieve` / `retain` / `reflect`
- OTLP exporter (logs are already structured JSON)
- Metrics emitted: `ingest_throughput`, `recall_p50/p95/p99`, `embedder_ms`,
  `rerank_ms`, `cache_hit_rate`

### H.2 — Resilience `~1.5d`

- Exponential backoff + jitter on Ollama / OpenAI / Anthropic calls
  (3 retries default)
- Circuit breaker on consecutive embedder failures (auto-fall-back to the
  configured fallback provider)
- Bound the Obsidian cache (LRU cap with documented max entries) — the
  simplify review flagged unbounded Map growth

### H.3 — Multi-tenancy `~2d`

- Promote `namespace: { user_id, session_id, agent_id }` from optional to
  first-class
- Per-namespace partition (separate JSONL file or pgvector schema)
- Audit log: every retain/recall stamped with namespace

### H.4 — Cost & token tracking `~1d`

- Per-session: `tokens_in`, `tokens_out`, `usd` per provider
- Written to `session.json` on `endSession`
- Aggregate across sessions for billing / dashboards

### H.5 — Schema migration tooling `~1d`

- Versioned manifest: `schema_version: 1.0.0` — reject loads from
  incompatible versions with a clear error message
- Migration scripts when `atomic_index.jsonl` shape evolves

---

## Phase 5 — Developer Experience `~3d`

### D.1 — GKS as an MCP server `~2d`

- New package: `gks-mcp-server`
- Exposes `recall` / `retain` / `lookup` / `proposeInbound` as MCP tools
- Closes the loop: GKS becomes the memory layer that Claude Code, Cursor,
  and other MCP clients talk to over the wire
- **Deps:** `@modelcontextprotocol/sdk` (shared with B.4)

### D.2 — REPL / CLI `~0.5d`

```sh
npx gks recall "tri-brain architecture"
npx gks retain "User prefers dark mode"
npx gks reflect --session=MSP-SESS-...
```

Thin wrapper around the patterns in `examples/quickstart.ts`.

### D.3 — Architecture documentation `~0.5d`

- ADR series in `gks/adr/<slug>.md` (flat type-folder layout per ADR-013)
- Mermaid diagrams: layer dependency graph, retain/recall flow, bi-temporal
  lifecycle

---

## Phase 6 — Release `~1d`

### R.1 — semver + changelog `~0.5d`

- Adopt `changesets` or `semantic-release`
- Tag the current PR #1 bundle as **v3.5.0** (matches `package.json`)

### R.2 — npm publish `~0.5d`

- Scoped package: `@evaai/gks`
- Public API exports: `MemoryStore`, `retain` / `recall` / `reflect`,
  `GraphStore`, types
- `engines.node`: `>=20`

---

## Dependency Graph

```
B.1 (pgvector)  ─────┬──→ B.3a (PG graph)  ─────┐
                     │                           │
B.2 (HNSW)         ──┤   (alt: B.3b Kuzu)        │
B.4 (MCP stdio)    ──┼─→  G3.x (real benchmarks) ─→  R.1 → R.2
B.5 (rerank fix)   ──┘                           ↑
                                                 │
H.1 H.2 H.3 H.4 H.5  ───────────────────────────┘

D.1 (MCP server)  needs the MCP SDK introduced by B.4
D.2 (CLI)         independent
D.3 (ADRs)        independent
```

**Critical path:** `B.1 → B.3a → G3.1 → G3.2 → G3.3 → R.1` ≈ **6–8 days
sequential**.
**Parallel best case (3 streams):** ≈ **3–4 days** to the first SOTA-claim
benchmark run.

---

## Effort Summary

| Phase | Items | Sequential | Parallel best |
|---|---|---|---|
| 2B Infra adapters | 5 | ~6d | ~2.5d |
| 3 Real benchmarks | 4 | ~4d | ~3d |
| 4 Production hardening | 5 | ~7d | ~3d |
| 5 Developer experience | 3 | ~3d | ~1.5d |
| 6 Release | 2 | ~1d | ~1d |
| **Total** | **19** | **~21d** | **~10.5d** |

---

## Decision log

| Decision | Rationale |
|---|---|
| **Cut FalkorDB** (was B.3 in v1) | SSPL license blocks SaaS, no native bi-temporal support, requires running a separate Redis-protocol service. |
| **B.3a Postgres tables** chosen as primary | Free if B.1 ships first (shared instance); transactional consistency with pgvector; PostgreSQL license is permissive; SQL recursive CTEs handle our BFS needs. |
| **B.3b Kuzu** retained as alternative | For users who want embedded Cypher without Postgres. MIT license, official Node.js binding, single-file persistence. |
| **Skip Neo4j** | Overkill for our scale (≤ 10M edges), heavy ops, AGPL/commercial license drama. |
| **Skip Apache AGE** | Postgres extension is finicky, version conflicts with pgvector reported in the wild. |

---

## What this plan does **not** cover

These are out of scope for the SOTA-production milestone but worth tracking:

- Federated / multi-region deployment
- Knowledge distillation (compressing old episodic to gist embeddings)
- Self-hosted reranker fine-tuning
- Plugin system for tools (currently a static registry per `FRAME`)
- Web UI / dashboard (CLI + MCP server are the supported surfaces)
- Real-time streaming retrieval (current model is request/response)

---

*See `BLUEPRINT--memory` for layer specifications and
`FRAME--TRI-BRAIN-ARCHITECTURE` for the broader system context.*
