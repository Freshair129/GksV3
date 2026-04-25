# Changelog

All notable changes to GKS v3 are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/).

## [3.5.0] — 2026-04-25

The first release. Three months of design, build, and review compressed
into one tag because Phase 1 through Phase 5 all landed before the first
publish — the tree was always private up to this point.

### Added

#### Memory layers
- **Atomic** layer with JSONL index, exact-id lookup that never
  hallucinates, hot-reload via mtime, filter by phase / type / status /
  tag.
- **Vector** layer with three pluggable backends:
  - JSONL `VectorStore` (default) — file-per-store with an
    embedder-aware manifest.
  - `PgvectorBackend` — Postgres + pgvector, HNSW index with
    `vector_cosine_ops`, `pg-copy-streams` for batch ingestion,
    transactional `patchMetadataMany`.
  - `HnswBackend` — in-process `hnswlib-node`, single-file persistence,
    O(log N) recall.
- **Obsidian** layer with two adapters:
  - `RestObsidianAdapter` — Local REST API plugin client.
  - `MCPObsidianAdapter` — JSON-RPC 2.0 over stdio.
  - Both wrapped in a bounded LRU + TTL cache.
- **Episodic** layer with append-only session traces and overwrite-
  refusing markdown summaries.
- **Inbound queue** — the only authorized write path to anything
  destined for `gks/`.

#### Core API
- `retain(content, namespace?, conflictPolicy?)` with bi-temporal
  versioning (`valid_from` / `valid_to` / `superseded_by`), namespace-
  scoped conflict resolution, single-embed optimization, and batched
  predecessor invalidation.
- `recall(query, options?)` with multi-source parallel retrieval,
  dedup, stable-status boost, pluggable reranker pass, max-total cap.
- `reflect(input)` running the deterministic Three-Gate Consolidator
  with a pluggable LLM-backed extractor (Anthropic Sonnet 4.6 default).

#### Multi-tenancy
- First-class `Namespace` type (`tenant_id` / `user_id` / `session_id` /
  `agent_id`) threaded through retain / recall / supersede.
- `crossNamespace: true` opt-out for admin / analytics paths.
- Append-only `AuditLog` (day-rotated JSONL) stamping every retain /
  recall / lookup / proposeInbound / writeEpisodic with the active
  namespace.

#### Production hardening
- Retry with exponential backoff + full jitter on every network call.
- Circuit breaker per provider; auth errors don't trip the breaker.
- Bounded LRU on the Obsidian cache.
- `CostTracker` with per-(provider, model) tallies, default pricing
  table for Anthropic / OpenAI / Ollama, end-of-session summary
  written to `session.json`.
- `schema_version` field on every manifest with semver-style
  compatibility enforcement (refuse on major mismatch, log on minor).
- `gks-migrate` runner for forward-migrating stores.

#### Observability
- OpenTelemetry façade with no-op default — zero tax when no SDK is
  registered.
- Spans on `gks.retain` / `gks.recall`, histograms for embedder /
  rerank / recall latency, counters for retain docs / cache hit/miss.
- `setupTelemetry()` opt-in OTLP wiring with AsyncHooks context
  manager.

#### Surfaces
- `gks-mcp-server` — MCP server exposing six tools over stdio.
- `gks` CLI — `init / retain / recall / lookup / propose-inbound /
  reflect / status` subcommands with stdin support and `--json` mode.

#### Benchmarks
- Backend-pluggable runners for **LoCoMo**, **LongMemEval**, and
  **BEAM** (10M-token scale).
- `bench:sweep` orchestrator running the embedder × reranker × backend
  matrix, output stamped with git SHA, Node version, and platform.
- Tiny fixtures shipped for offline smoke testing.

#### Docs
- `docs/ARCHITECTURE.md` with five mermaid diagrams (layer dependency,
  retain flow, recall flow, bi-temporal lifecycle, cross-cutting).
- `docs/ULTRAPLAN.md` — six-phase roadmap.
- `docs/BENCHMARKS.md` — operator guide with target table.
- `docs/OBSERVABILITY.md` — collector config + dashboard cheat-sheet.
- `docs/MIGRATIONS.md` — schema-version policy.
- `docs/adr/` — seven Architecture Decision Records (file-based vector
  default, bi-temporal supersede, pluggable backends, namespace as
  first-class, FalkorDB cut, OTel no-op default, MCP stdio-only).

### Tests
- 237 passing across 32 test files; 3 opt-in (gated by env vars for
  live rerank server).
- CI runs Node 20 + 22 with mock embedder for hermeticity.

### Known gaps (deferred)
- Real-scale benchmark numbers (Phase 3 tooling is in place; the runs
  themselves need infra the project ships docker-compose files for).
- `KuzuGraphBackend` for users who want embedded graph without
  Postgres.
- HTTP transport for the MCP server (stdio only in 3.5.0 by design;
  see ADR 007).

[3.5.0]: https://github.com/freshair129/gksv3/releases/tag/v3.5.0
