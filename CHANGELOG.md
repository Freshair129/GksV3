# Changelog

All notable changes to GKS v3 are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/).

## [3.5.1] — 2026-04-26

Post-3.5.0 quality, security, and architectural-clarity pass. No public
API changes; safe to upgrade.

### Security (audit pass)

- `AtomicLayer.readBody` now bounds-checks the resolved path against
  `gksRoot` — defense-in-depth against a poisoned `atomic_index.jsonl`
  entry escaping the gks tree.
- LLM-supplied `confidence` clamped to `[0, 1]` + `Number.isFinite`
  guarded at the consolidator extraction edge so a malicious model
  reply can't pollute downstream Three-Gate scoring or inbound
  artefacts.
- New `redactSecrets()` helper masks Bearer tokens / `x-api-key` /
  `sk-…` / JWTs in upstream HTTP error bodies before they propagate
  via thrown errors → logs → OTel spans. Wired into Anthropic,
  OpenAI, Ollama, rerank, and Obsidian REST clients.
- `InboundArtifact.namespace` stamped at retain time + rendered into
  the proposal's frontmatter so reviewers see provenance at promotion.
- Frontmatter values now go through a shared `yamlLite` escaper
  (extracted to `src/lib/yaml-lite.ts`); attacker-controlled fields
  with `:` / `#` / `\n` can no longer break out of their slot.
- LLM extractor JSON capped at 1 MiB before `JSON.parse` (DoS guard).
- `safeLimit()` helper hardens the SQL `LIMIT` interpolations in
  pgvector + pg-graph (NaN / Infinity / negative input bounded).
- Spoofed `[USER] / [AGENT]` turn-tag injection neutralised in the
  consolidator prompt (a user message containing `\n[AGENT] …` no
  longer reads as an agent turn to the LLM).
- `RetrievalHit.snippet` JSDoc + MCP tool descriptions now explicitly
  flag snippets as untrusted when fed back into LLM prompts.
- `gks_lookup` MCP tool description now states atomic notes are
  global by design — don't store tenant-private content there.

### Cleanup (`/simplify` round 2 — four commits)

- New shared `src/lib/sql.ts` (`quoteIdent`, `withTx`, `escapeCopyField`,
  `isMissingTable`, `safeLimit`); de-duplicates three previously-drifting
  copies. `pgvector.copyInDocs` latent transaction bug fixed in passing.
- `src/memory/atomic-id.ts` as the single source of truth for
  `ATOMIC_ID_PATTERN` + `isAtomicId` (5 inline regex copies → 1).
- Shared `truncate` from `src/lib/text.ts` (4 inline copies → 1).
- Exported `namespaceAsFilter` and replaced an inline duplicate in
  `api.ts`.
- New `gksLayout(root)` helper — single source for the
  `.brain/msp/projects/evaAI/{vector,session,memory,inbound,audit}/`
  layout (6 hard-coded path copies → 1).
- `hnsw.ts` metadata rewrite uses `writeJsonl`.
- `test/fixtures/mock-pg-pool.ts` shared between `pgvector` and
  `pg-graph` test files.
- `audit.ts` no longer double-mkdirs (the JSONL helper does it).
- `graph.ts` BFS swaps `queue.shift()` (O(n)) for a head pointer.
- `STABLE_BOOST = 0.05` extracted as a named constant.
- Concurrency fix: `getVectorStore()` and `embedder()` now cache
  in-flight promises so concurrent first-callers share one init.
- `MCPObsidianAdapter` no longer leaks an orphan child process.
- `gks lookup --json` exits 0 with `{found:false}` on miss instead
  of conflating "not found" with "error".

### Architectural docs

- **`SCOPE.md`** — explicit in/out list with a 5-question decision
  rule for proposed features. Reads as a guardrail for future scope
  creep.
- **`docs/MSP_RELATIONSHIP.md`** — records why GKS is shaped to receive
  an MSP-like Memory OS layer above without depending on one. Adds a
  "Coexisting with peer subsystems" section covering the GitNexus
  pairing pattern.
- **`examples/memory-os-architecture/`** — Python proof-of-concept
  layering a paradigm-agnostic Memory OS kernel + EVA plugin (RMS / RI
  levels / Pulse Snapshot) + storage adapters (`JsonFile` and
  `Gks`-via-MCP). Three smoke-test scenarios pass; demonstrates how a
  Memory OS plugs into GKS without touching `src/`.
- **README** — new "Pairing with a code-structure layer (e.g.
  GitNexus)" section + scope callout in the intro.
- Source comments at `src/memory/inbound.ts` and
  `src/memory/index.ts:gksLayout` now point at
  `MSP_RELATIONSHIP.md` so the design intent isn't lost on edit.

### ADRs

- **ADR-008** — GKS as storage engine; Memory OS layer above
  (MSP-shaped contract). Records the vertical layering decision +
  alternatives considered.
- **ADR-009** — MSP orchestrates peer subsystems; GKS does not proxy
  them. Records the horizontal layering decision (GKS + GitNexus as
  peers, not chained) + the `linked_symbols` cross-reference idea.

### Added

- `linked_symbols` field on `InboundArtifact` + `RetainInput` —
  optional list of `{ file, fn?, line? }` tuples that an atom governs.
  GKS only stores + serialises them; resolution against an actual
  codebase is the orchestrator's job (e.g. MSP fans out to GitNexus
  per ADR-009). Available across all surfaces:
  - TS API: `linkedSymbols` on `RetainInput`
  - MCP: `linked_symbols` on the `gks_propose_inbound` tool (Zod-strict schema)
  - CLI: `gks propose-inbound … --linked-symbol=src/x.ts:fn:line` (repeatable)
- `yamlLite` now renders arrays of objects as flow-style JSON scalars
  (`- {"file":"...","fn":"..."}`) — needed for `linked_symbols` and
  any future nested frontmatter values.

### Tests
- 241 passing (was 237 in 3.5.0) across 32 test files; 3 still opt-in.
  +3 new tests: 2 inbound (renders / omits) + 1 CLI (round-trip).

[3.5.1]: https://github.com/freshair129/gksv3/releases/tag/v3.5.1

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
