# Changelog

## 3.6.0

### Minor Changes

- **New: nomic-embed-text-v1.5 local embedder (Thai+English)**

  - `createNomicEmbedder()` — runs `nomic-ai/nomic-embed-text-v1.5` via `@huggingface/transformers`, fully local, no Ollama required
  - 768-dim, 2048 token context, Thai+English mixed content support
  - Task prefixes (`search_document:` / `search_query:`) applied internally
  - Progress logged to stderr on first download (~550MB, cached after)
  - New auto-chain order: **nomic → ollama → openai → mock**

  **New: public API exports**

  - `retain()`, `recall()`, `reflect()` now exported from `@freshair129/gks`
  - `createNomicEmbedder()` exported from `@freshair129/gks`

  **New: Claude Code skill layer**

  - 10 slash commands in `.claude/commands/`: `/retain` `/recall` `/lookup` `/new-feature` `/propose` `/verify` `/validate` `/hotfix` `/reflect` `/status`

  **Migration note**

  If you have existing data embedded with Ollama (bge-m3, 1024-dim), run `npm run re-embed` after upgrading to rebuild vector stores with the new 768-dim nomic embedder. To keep using Ollama: set `GKS_EMBEDDER=ollama`.

## 3.5.6

### Patch Changes

- Fix Windows compatibility and benchmark sweep metric extraction.

  - CLI and re-indexer integration tests now work on Windows (`spawnSync` uses `shell: true` + `npx.cmd`)
  - HNSW tests skip gracefully when native addon is not compiled for the current Node version
  - Benchmark sweep (`bench:sweep`) correctly extracts headline metrics from multi-line runner output
  - Remove unused `FRAME--TRI-BRAIN-ARCHITECTURE` document (eva-cli spec belongs in a separate repo)

All notable changes to GKS v3 are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/).

## [3.5.5] — 2026-04-28

The master-spec doc-to-code release. Folds three architectural decisions
(ADR-013, ADR-014, ADR-015) and the tooling that lets agents and
contributors actually live by them: chain-walking gates, a hotfix
escape hatch, an end-to-end scaffolder, six new MCP tools, the missing
inbound `promote` primitive, a self-hosted CI workflow, and a working
orchestrator-side task-tracker example.

### Architectural decisions

- **ADR-013** — flat atom layout. `gks/<type>/` replaces
  `gks/phase{1,2,3}_*/<type>/`. Atoms shifting phase no longer move
  files; the in-memory `AtomicLayer.filter({ phase })` still works.
- **ADR-014** — doc-to-code enforcement model. Maps master-spec §6
  (P1–P6 phases, Agent Rule §6.3, Hotfix Escape Hatch §6.4, CLI
  surface §6.5, MSP Gatekeeper §7) onto GKS primitives. Six items, all
  storage-engine scope per ADR-008.
- **ADR-015** — task tracking belongs to the orchestrator, not GKS.
  Supersedes ADR-014 item 1: removes `TASK--` from the atomic
  taxonomy. Live task / subtask / microtask state lives in MSP / a
  tracker / `.brain/<ns>/tasks/`, not in `gks/`. Atoms keep
  `BLUEPRINT--` (work shape) and `AUDIT--` (outcome); execution state
  in between is the orchestrator's job.

### Added — gates + scaffolders

- **`gks verify-flow <id>`** — chain walker (ADR-014 item 3). Walks
  `crosslinks.references / implements / parent_blueprint / resolves`
  from a root atom; reports missing atoms, `not_approved` status, and
  broken crosslinks. Cycle-safe; surfaces every issue, not just the
  first. Exit-1 composes into pre-commit / CI.
- **`gks validate --links`** — read-only crosslink integrity check
  across every key in the index (ADR-014 item 6).
- **`gks new-feature <slug>`** — scaffolder (ADR-014 item 5). One
  command drops 4 candidates (CONCEPT / ADR / FEAT / BLUEPRINT) into
  the inbound queue with `geography` + `linked_symbols` pre-filled
  from `--blueprint-file=`. Microtasks per ADR-015 are NOT atoms;
  `--task-tracker=local|msp|external` picks the orchestrator-side
  destination (`local` writes `T<n>_*.task.yaml` skeletons under
  `.brain/<ns>/tasks/`; the others print handoff guidance).
- **`gks hotfix open|list|close|check`** (ADR-014 item 4). Opens a
  `HOTFIX--<short-sha>` atom with `valid_to = now + 48 h`; the
  pre-commit gate (`examples/drift-detection/hotfix-gate.sh`) lets
  staged files through during the window and blocks afterwards until
  backfill atoms reference the hotfix via `crosslinks.resolves`.
- **Status alias** (ADR-014 item 2). `normaliseStatus()` and
  `isApprovedStatus()` accept master-spec wording (`APPROVED`,
  `Accepted`) at the boundary and map it to the canonical `stable`
  enum value — no SSOT split between two words for the same notion.

### Added — inbound queue review surface

- **`gks inbound list [--type=…]`**, **`gks inbound show ID`**,
  **`gks inbound promote ID [--force] [--status=…]`**.
  `InboundQueue.promote()` moves `<inbound>/<id>.<rev>.md` to
  `<gks>/<type>/<id>.md`, strips review-only frontmatter (`review_id`,
  `proposed_at`, `source_session`, `confidence`, tenant/user/session/
  agent ids), renames `proposed_id → id`, sets `status: stable`, and
  drops the auto-prepended title H1 so the canonical body keeps a
  single descriptive heading. Refuses to overwrite an existing dest
  without `--force`. The docs (WORKFLOW.md, ONBOARDING.md) had been
  documenting this flow for two releases without it actually existing.

### Added — MCP tools (13 total, was 7)

Six new stdio tools so agents using GKS over MCP can satisfy the Agent
Rule §6.3 without shelling out:

- `gks_verify_flow` — wraps `verifyFlow`
- `gks_validate_links` — wraps `validateLinks`
- `gks_new_feature` — wraps `scaffoldNewFeature`
- `gks_hotfix_open` / `gks_hotfix_list` / `gks_hotfix_close` — wrap
  `HotfixStore` open / list / close

Zod-strict input schemas, JSON-encoded `text` content blocks. SERVER
version bumped to 3.5.5 (was 3.5.4); README MCP tool count updated.

### Added — atoms recognised in the taxonomy

- `HOTFIX--` (light tier) — escape-hatch atom with required `valid_to`
  - `meta.commit_sha`. `gks/hotfix/`. Closed by backfill atoms via
    `crosslinks.resolves`.

Removed (no production users — ADR-015):

- `TASK--` prefix dropped from `AtomicType` union and the recognised
  taxonomy. The `crosslinks.parent_blueprint` graph edge stays — it's
  a generic key any future durable child atom may use, and
  `verify-flow` keeps walking it.

### Added — examples

- **`examples/full-flow/run-feature.sh`** — guided end-to-end runner
  composing `recall → new-feature → inbound promote → verify-flow`.
  Pauses for `$EDITOR` review by default; `--auto-promote` for
  headless / CI use.
- **`examples/msp-task-tracker/`** — orchestrator-side reference
  implementation per ADR-015. `tracker.openProjectFromBlueprint(…)`
  reads `BLUEPRINT.geography` and creates open tasks in
  `.brain/<ns>/tasks/<slug>/state.json`; on `closeProject(…)` it
  builds an `AUDIT--` candidate and pipes it back through
  `MemoryStore.inbound.propose`. End-to-end smoke test green.
- **`examples/drift-detection/hotfix-gate.sh`** — pre-commit hook for
  the 48-hour backfill window.
- **`examples/atom-templates/`** — `HOTFIX.md` added; `TASK.md`
  removed; existing templates annotated with crosslink-type semantics
  (Backlink / Peer Link / Resolution Link / Context Link).

### Added — CI + contributor docs

- **`.github/workflows/gks-gates.yml`** — self-hosted gate. Runs
  `npm run msp:index` and asserts zero diff against the committed
  `atomic_index.jsonl`, then `gks validate --links`, then
  `gks verify-flow` over every `gks/feat/FEAT--*.md`. Triggers on PR
  to main and push to main.
- **`CONTRIBUTING.md`** — local-enforcement section pointing at the
  example pre-push and pre-commit hooks; corrected hotfix CLI usage.
- **`docs/ONBOARDING.md`** — incremental seven-phase adoption guide
  for existing projects, with a full-migration playbook for the cases
  where it's actually warranted (compliance, EOL doc system, handoff,
  < 50 pages, doc rewrite).
- **`docs/WORKFLOW.md`** — daily P1 → P6 loop with every CLI command
  at the right step, the hotfix sub-flow, the Agent Rule reduction to
  a single `verify-flow` call, status transitions, and the three-hook
  CI stack.
- **`docs/MSP_RELATIONSHIP.md`** — new "Task tracking — orchestrator
  territory (ADR-015)" section with the contract table and three
  concrete tracker homes.

### Bootstrap (eat-our-own-dog-food)

- `gks/` tree grew from 7 to 9 atoms: added
  `ADR--DOC-TO-CODE-ENFORCEMENT` and
  `ADR--TASK-TRACKING-AT-ORCHESTRATOR` mirrors. `verify-flow` and
  `validate --links` both pass against the live index.

### Tests

- 321 passing (was 278 in 3.5.4) across 43 test files; 3 still opt-in.
  +43 new tests covering MCP gates, hotfix store, status alias,
  verify-flow, validate-links, scaffolder + tracker modes, inbound
  promote, msp-task-tracker example.

### Notes

- `AtomicEntry.phase` enum is unchanged (0–5). Master-spec §6.2
  references P6; the schema cap of 5 stands — `AUDIT--` atoms use
  `phase: 5` per the existing convention.
- The MCP server still ships stdio only (ADR-007). `gks_recall_cross_namespace`
  remains gated behind `exposeCrossNamespace`.

[3.5.5]: https://github.com/freshair129/gksv3/releases/tag/v3.5.5

## [3.5.4] — 2026-04-26

Closes the implementation half of [ADR-012](./docs/adr/012-extended-taxonomy.md):
ships a self-hosted issue tracker so projects can manage live issues
inside GKS without depending on Linear / Jira / GitHub Issues.

### Added

- **`IssueStore`** (`src/issue/store.ts`) — file-backed issue tracker
  per ADR-012's light-governance tier. One `.md` file per issue under
  `gks/issues/<ID>.md`; direct write (no inbound queue); schema-validated
  at every mutation; comments append-only by convention.
  - `create`, `list` (with status / priority / assignee / label
    filters), `show`, `comment`, `setStatus`, `assign`, `close`
  - Auto-disambiguates colliding ids; auto-stamps `closed_at` on
    close/wontfix transitions
  - Records audit events for every mutation (`issue_create`,
    `issue_comment`, `issue_status_change`, `issue_assign`, `issue_close`)
- **`Issue` schema** (`src/issue/types.ts`) — `IssueStatus` enum
  (open / triaged / in_progress / blocked / closed / wontfix),
  `IssuePriority` enum (low / medium / high / urgent), validators,
  slug-from-title helper.
- **CLI** — 8 subcommands under `gks issue`:

  ```sh
  gks issue new "Title" [--priority=…] [--label=…] [--assignee=…] [--reporter=…] [--body=…]
  gks issue list [--status=open|closed|all] [--priority=…] [--label=…] [--assignee=…] [--json]
  gks issue show ID [--json]
  gks issue comment ID "TEXT"
  gks issue status ID NEW_STATUS
  gks issue assign ID ASSIGNEE
  gks issue close ID [--resolved-by=ADR-…]
  gks issue dashboard [--md]
  ```

- **Audit ops** — `issue_create`, `issue_comment`, `issue_status_change`,
  `issue_assign`, `issue_close` added to the `AuditOp` union.

### Tests

- 278 passing (was 256 in 3.5.3) across 35 test files; 3 still opt-in.
  +22 new tests: 13 IssueStore unit + 9 CLI E2E covering happy path /
  filter / comment round-trip / status transitions / assignee /
  close-with-resolved-by / dashboard / JSON mode / invalid-status
  rejection.

### Notes

- Issues live in the **light-governance** tier (`gks/issues/`) — direct
  write is OK; the strict tier (`gks/{adrs,blueprints,…}/`) still routes
  through the inbound queue.
- The MCP server does NOT yet expose `gks_issue_*` tools; that's the
  natural follow-up if there's demand.

[3.5.4]: https://github.com/freshair129/gksv3/releases/tag/v3.5.4

## [3.5.3] — 2026-04-26

Closes the data path for `lookupBySymbol` (3.5.2). Before this release
the JSONL atomic index had to be hand-edited or built by an external
tool; the new re-indexer script regenerates it from `gks/**/*.md`
frontmatter, including the `linked_symbols` and `geography` citations
that ADR-010 made queryable.

### Added

- **`scripts/msp/re-indexer.ts`** + `npm run msp:index` — walks
  `gks/**/*.md`, parses YAML frontmatter (proper `yaml` parser, not the
  inline minimal one used for our own writes), normalises the entries,
  and writes a deterministic `gks/00_index/atomic_index.jsonl`.
  - Sorted by id (diff-friendly).
  - Skips files without an `id` or with an invalid `id` format
    (per `ATOMIC_ID_PATTERN`); reports counts.
  - Skips the `00_index/` directory itself (no self-reference).
  - Preserves `linked_symbols` + `geography` so the index is
    immediately `lookupBySymbol`-ready (ADR-010 round-trip closed).
  - `--dry-run` previews stats without writing.
  - `--verbose` lists each indexed / skipped file.

### Tests

- 256 passing (was 251 in 3.5.2) across 33 test files; 3 still opt-in.
  +5 new integration tests covering happy path, citation preservation,
  invalid-id skipping, dry-run, and self-reference avoidance.

[3.5.3]: https://github.com/freshair129/gksv3/releases/tag/v3.5.3

## [3.5.2] — 2026-04-26

Closes the bidirectional traceability loop. `linked_symbols` (3.5.1)
made atoms cite code; this release makes those citations queryable in
reverse — given a code path, find the atoms that govern it.

### Added

- `MemoryStore.lookupBySymbol(symbolPath)` — reverse citation lookup.
  Match semantics defined in ADR-010 (file-level / fn-level / line-
  level matching across both `linked_symbols` and `geography`).
- CLI: `gks lookup-by-symbol src/x.ts:foo[:line]` (with `--json` output).
- MCP tool: `gks_lookup_by_symbol` (Zod-strict input).
- Audit log: new `lookup_by_symbol` op. Symbol path + hit count
  recorded; symbol value not redacted (paths are not credentials).
- `AtomicEntry.linked_symbols` and `AtomicEntry.geography` — atomic-
  index rows now preserve these fields so reverse lookups work
  without re-parsing markdown frontmatter.

### Architectural

- **ADR-010** — Bidirectional traceability via reverse citation
  lookup. Records the gap (AST → atoms had no answer until now), the
  in-scope reasoning under ADR-008 (query primitive over stored data),
  and the boundary with GitNexus per ADR-009 (orchestrator combines
  the two; GKS still has no GitNexus dependency).

### Tests

- 251 passing (was 241 in 3.5.1) across 32 test files; 3 still opt-in.
  +10 new tests covering match semantics + CLI + MCP round-trips.

[3.5.2]: https://github.com/freshair129/gksv3/releases/tag/v3.5.2

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
- `examples/gitnexus-graph-cache/` — reference adapter for the
  GitNexus → `GraphStore` denormalisation pattern that ADR-009
  authorises. `sync.ts` lands an AST export into a GKS graph JSONL
  with stamped provenance (`source: 'gitnexus'`, `synced_at`,
  `codebase_sha`). `query-cached.ts` walks outbound or inbound from a
  seed symbol with optional `--as-of` for bi-temporal reasoning. End-
  to-end smoke test (`smoke-test.ts`, 7 assertions) passes.

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
