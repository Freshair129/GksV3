# GKS — Technical Overview

> **Genesis Knowledge System (GKS)** — a TypeScript storage engine for
> agent memory. Four cooperating layers, three verbs, multi-tenancy,
> bi-temporal versioning, observability, MCP server, CLI.
>
> This document is the **standalone technical reference** for GKS. It is
> intentionally separate from `FRAMEWORK_MASTER_SPEC.md` — that file
> describes the EVA project's full meta-framework (multi-agent workflow,
> 7-phase build pipeline, governance), while this file describes only
> what GKS itself does, why it does it, and how to use it. If you want
> the storage engine without the rest of the EVA stack, this is the
> only doc you need.
>
> **Audience:** engineers integrating GKS into an agent system, building
> on top of it, or extending it via its plugin points.
>
> **Version:** 3.5.4 (2026-04). See `CHANGELOG.md` for the per-release
> history.

---

## 1. What GKS is

GKS is a **storage engine for agent memory**. It exposes a small,
opinionated API (`retain`, `recall`, `reflect` plus a handful of helpers)
backed by four cooperating storage layers (Atomic, Vector, Episodic,
Obsidian). Production-ready primitives — bi-temporal versioning,
multi-tenant `Namespace` isolation, append-only audit log, OpenTelemetry
traces, retry + circuit breaker, schema-versioned manifests, cost
tracking — are wired in by default.

GKS is **not** a Memory OS. It does not own consolidation timing,
session orchestration, affect / RI / RMS scoring, or any cognitive
model. It does not parse source code into ASTs or build call graphs. It
does not run validation workflows or phase gates. Those concerns live
in layers above (a Memory OS / orchestrator like MSP) or in peer
subsystems (a code-intelligence engine like GitNexus). See
[`SCOPE.md`](../SCOPE.md) for the explicit in/out list and
[`docs/MSP_RELATIONSHIP.md`](./MSP_RELATIONSHIP.md) for the boundary
contract.

GKS is **paradigm-agnostic by design**. It works equally well with a
single-tenant CLI agent, a multi-tenant SaaS deployment, an MSP-shaped
Memory OS layered above, or a research project with a custom
consolidation cascade. The narrow contract surface (~30 type
declarations, 5 plugin interfaces, 8 MCP tools) is deliberate.

---

## 2. Architecture

### 2.1 Layered model

```
┌─────────────────────────────────────────────────────────────────┐
│ Agent (any LLM — Claude / GPT / local Llama / …)                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ retain / recall / reflect
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Memory OS / orchestrator (MSP, custom, …)  ── NOT IN THIS REPO  │
│   • policy: when to consolidate / what to keep                  │
│   • scheduling: session cascade timing                          │
│   • workflow: validation / promote / drift detection            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ store / query / patch
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ GKS  (this repo)                                                │
│   ┌───────────┬──────────┬──────────┬──────────┐                │
│   │  Atomic   │  Vector  │ Episodic │ Obsidian │  4 storage     │
│   │  (exact)  │ (semant) │ (session)│  (graph) │  layers        │
│   └───────────┴──────────┴──────────┴──────────┘                │
│   ┌─────────────────────────────────────────────┐               │
│   │ MemoryStore — single façade                 │               │
│   │  • retain / recall / reflect                │               │
│   │  • lookup / lookupBySymbol                  │               │
│   │  • proposeInbound / writeEpisodic            │               │
│   └─────────────────────────────────────────────┘               │
│   ┌─────────────────────────────────────────────┐               │
│   │ IssueStore — light-tier issue tracker       │               │
│   │  (separate from MemoryStore — ADR-012)       │               │
│   └─────────────────────────────────────────────┘               │
│   ┌─────────────────────────────────────────────┐               │
│   │ Cross-cutting: audit · cost · OTel · retry · │               │
│   │ circuit-breaker · schema-version · namespace │               │
│   └─────────────────────────────────────────────┘               │
└──────────────────────────┬──────────────────────────────────────┘
                           │ raw I/O
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Backends (pluggable per-layer, swappable at construction)       │
│  Vector:    JSONL · HNSW (hnswlib-node) · pgvector              │
│  Graph:     in-memory · pgvector tables (PgGraphBackend)        │
│  Reranker:  BM25-lite · HTTP cross-encoder · custom fn          │
│  Obsidian:  REST adapter · MCP-stdio adapter · in-process mock  │
│  Embedder:  Ollama bge-m3 · OpenAI · deterministic mock         │
│  LLM:       Anthropic (consolidator)                            │
└─────────────────────────────────────────────────────────────────┘

Peer subsystems (NOT in this repo, NOT a layer):
  GitNexus — code AST + call graph (per ADR-009 — orchestrator
  combines GKS + GitNexus, GKS imports nothing from it)
```

Three layers in the stack:

1. **Above GKS:** the agent and (optionally) a Memory OS that owns
   policy and workflow. GKS is unaware of either.
2. **GKS itself:** four storage layers + a unified `MemoryStore` façade
   + supporting infrastructure (audit, cost, telemetry, etc.).
3. **Below GKS:** swappable backends per layer. JSONL is the zero-deps
   default; pgvector / HNSW / Postgres-graph are production options.

### 2.2 Why four layers (not three, not five)

Each layer answers a different *kind* of question and merges in
parallel:

| Layer | Question it answers | Latency budget | Source of truth |
|---|---|---|---|
| **Atomic** | "What is the canonical definition of `CONCEPT--X`?" | < 1 ms (in-memory map) | curated `gks/` markdown |
| **Vector** | "What docs are semantically near this query?" | tens of ms (HNSW) | embedder output + metadata |
| **Episodic** | "What did we discuss in this session?" | tens of ms (file scan) | session traces + summaries |
| **Obsidian** | "What does this knowledge graph say about X?" | tens-hundreds ms (REST) | external Obsidian vault |

The `recall()` verb fans out to all four in parallel, dedupes by
`(path \|\| id)`, applies optional reranking + a `STABLE_BOOST` for
status=stable docs, and caps the total result set. No layer is required
— configure only what you need.

### 2.3 Three layers, expanded role

This file uses "three layers" colloquially when contrasting GKS with
its environment:

- **Memory OS** = the layer above (policy + scheduling)
- **GKS** = this repo (storage + retrieval primitives)
- **Backends** = the layer below (where bytes physically live)

ADR-008 records why these three roles must stay separate. ADR-009
records why peer subsystems (GitNexus, etc.) sit *next to* GKS rather
than chained under it.

---

## 3. Storage layers

### 3.1 Atomic — exact-id lookup against curated markdown

**Source of truth:** the `gks/` directory tree of human-reviewed `.md`
files plus an `atomic_index.jsonl` summarising their frontmatter.

**Implementation:** `src/memory/gks.ts:AtomicLayer` — single class that
loads the JSONL index lazily, hot-reloads when the file's mtime
advances, and serves `lookup(id)` / `searchById(id)` / `filter(query)` /
`searchBySymbol(path)` (reverse citation lookup, ADR-010).

**Index row shape** (`AtomicEntry`):

```ts
interface AtomicEntry {
  id: string                          // ATOMIC_ID_PATTERN: TYPE--SLUG
  phase: 0 | 1 | 2 | 3 | 4 | 5
  type: AtomicType                    // 'adr' | 'feat' | 'algo' | 'issue' | …
  status: 'raw' | 'draft' | 'stable' | 'deprecated' | 'invalid'
  vault_id: string
  path: string                        // relative to gks/
  title?: string
  tags?: string[]
  crosslinks?: Record<string, string[]>
  valid_from?: string
  valid_to?: string | null
  linked_symbols?: LinkedSymbol[]     // ADR-010 — code citations
  geography?: string[]                // blueprint-only — file paths produced
}
```

**Guarantees:**
- `lookup('CONCEPT--X')` returns the canonical note's body verbatim from
  disk if the ID exists; `null` otherwise. Never approximates, never
  hallucinates.
- Bounds-check on `entry.path` resolution: refuses to read a file that
  resolves outside `gksRoot` (ADR-008 / security pass — defense against
  poisoned index entries).
- `atomic_index.jsonl` is rebuilt by `npm run msp:index`
  (`scripts/msp/re-indexer.ts` — walks `gks/**/*.md`, parses YAML
  frontmatter, writes a deterministic sorted JSONL, preserves
  `linked_symbols` + `geography`).

**When to use:**
- You have an exact ID (from a wikilink, a citation, an MCP tool reply).
- You need a stable canonical reference that survives 6 months of code
  refactors.
- You're combining citations across atoms ("which ADRs reference
  `CONCEPT--EVA-TRI-BRAIN`?").

**When NOT to use:** semantic queries — go through `recall(query)`
instead (which calls Atomic + Vector + Episodic + Obsidian in parallel).

### 3.2 Vector — semantic search with pluggable backends

**Source of truth:** depends on the backend. Default is JSONL + an
embedder-aware manifest. Swap at `MemoryStore` construction:

```ts
new MemoryStore({
  root: '.',
  vectorBackend: (name, embedder) => createPgvectorBackend({ pool, name, embedder }),
})
```

**Supported backends out of the box:**

| Backend | File | Best for | Persistence |
|---|---|---|---|
| `VectorStore` (default) | `src/memory/vector/index.ts` | dev, single-process, < 100k docs | JSONL + manifest |
| `HnswBackend` | `src/memory/vector/hnsw.ts` | local prod, fast O(log N), single-file | `.hnsw` index + `.meta.jsonl` |
| `PgvectorBackend` | `src/memory/vector/pgvector.ts` | multi-process, transactional, > 1M docs | Postgres + pgvector ext |

All three implement `VectorBackend`:

```ts
interface VectorBackend {
  readonly name: string
  addItem(args: { id?, source, chunkId?, text, vector, metadata }): Promise<VectorDoc>
  search(query: string | number[], opts?: VectorSearchOptions): Promise<VectorHit[]>
  patchMetadataMany(updates: Array<{ id, patch }>): Promise<void>
  // …
}
```

**Embedder layer:** sits in front of the backend. Auto-detects Ollama →
OpenAI → mock. Cost-tracker-wrapped: every embed call records token
counts (real from response when available, estimated otherwise).

**Conflict resolution at write time** (per ADR-002 — bi-temporal):
`retain()` searches for cosine-near matches in the same namespace,
classifies them by policy (`auto` / `supersede` / `coexist`), and
patches predecessors' `valid_to` timestamps when superseding.

### 3.3 Episodic — append-only session traces + consolidated summaries

**Two sub-layers:**

1. **Trace** — `<root>/.brain/.../session/<sessionId>.trace.jsonl` —
   append-only event log written by `appendTrace()`. One line per
   `TraceStep` (kind: `user` / `agent` / `tool` / `brain` / `memory` /
   `system`). Used as input to `reflect()`.

2. **Summary** — `<root>/.brain/.../memory/<sessionId>.md` — markdown
   with YAML frontmatter, written **once** by `writeEpisodic()`.
   Subsequent writes throw — episodic summaries are audit artifacts and
   never overwrite.

**Implementation:** `src/memory/episodic.ts:EpisodicLayer`.

**Frontmatter shape:**

```yaml
---
id: SESS-2026-04-26
session_id: MSP-SESS-260426ABCD
started_at: 2026-04-26T10:00:00Z
ended_at: 2026-04-26T11:30:00Z
duration_min: 90
participants: [MSP-USR-BOSS, MSP-AGT-RWANG-IDE]
tokens_total: 15234
cost_usd: 0.18
tags: [architecture, taxonomy]
linked_atoms: [CONCEPT--EVA-TRI-BRAIN, ADR--PARSE-TRACE-NORM]
emotion_summary: productive
outcomes:
  - extended atomic taxonomy 17 → 30 prefixes
  - shipped issue tracker
---
```

**When the body is generated:** `reflect()` runs the Three-Gate
Consolidator over the session trace. Default extractor is the
deterministic heuristic; if `ANTHROPIC_API_KEY` is set, the LLM-backed
extractor (Sonnet 4.6) generates `summary` + candidate atoms which feed
into `proposeInbound()`.

### 3.4 Obsidian — external graph + fulltext bridge

**Two adapters in the box:**

| Adapter | Transport | Use case |
|---|---|---|
| `RestObsidianAdapter` | HTTP | local Obsidian + Local REST API plugin |
| `MCPObsidianAdapter` | stdio JSON-RPC | hosted Obsidian via MCP |

Both implement `ObsidianAdapter`:

```ts
interface ObsidianAdapter {
  readonly id: string
  ping(): Promise<boolean>
  search(query: string, opts?: { limit?: number }): Promise<ObsidianSearchHit[]>
  resolveWikilink(link: string): Promise<ObsidianNote | null>
  backlinksOf(path: string, opts?: { limit?: number }): Promise<ObsidianSearchHit[]>
  tagQuery(tag: string, opts?: { limit?: number }): Promise<ObsidianSearchHit[]>
}
```

**Wrapped in a TTL + LRU cache** on the way in (default 120 s TTL, 1000
entry cap) — Obsidian round-trips are the slowest source so caching
matters.

**When to use:** you have an existing Obsidian vault and want its
fulltext + backlink graph as one of the recall sources without pulling
the data into GKS.

**When NOT to use:** as a primary store — Obsidian is read-mostly here.
For canonical knowledge use Atomic; for production semantic search use
Vector.

### 3.5 The fifth (light-tier): IssueStore

`src/issue/store.ts:IssueStore` is **not** part of `MemoryStore`. It's a
parallel storage primitive added in 3.5.4 for the self-hosted issue
tracker (ADR-012):

- Storage: `<root>/gks/issues/<ID>.md`, one file per issue
- Light governance: direct write OK (no inbound queue), schema-validated
  at every mutation, comments append-only by convention
- Surface: `IssueStore.create / list / show / comment / setStatus /
  assign / close` — and 8 CLI subcommands (`gks issue *`)

Why separate from `MemoryStore`? Because issues mutate frequently
(status changes, comments, reassignments) where atoms in the Atomic
layer are set-once-stable. Mixing the two would force every atom to
inherit the issue lifecycle. ADR-012 records the alternatives and why
this split was chosen.

---

## 4. Core API — three verbs

GKS's public API has three primary verbs (`retain`, `recall`, `reflect`)
plus a handful of helpers (`lookup`, `lookupBySymbol`, `proposeInbound`,
`writeEpisodic`, `appendTrace`). All three primary verbs accept a
`MemoryStore` as the first argument — the store owns the lifecycle of
all four storage layers.

### 4.1 `retain` — write a fact

```ts
import { retain } from '@evaai/gks'

const result = await retain(store, {
  content: 'User prefers dark mode in the CLI.',
  metadata: { path: 'preferences/dark-mode.md', tags: ['ui'] },
  namespace: { tenant_id: 'acme', user_id: 'alice' },
  conflictPolicy: 'auto',                    // 'auto' | 'supersede' | 'coexist'
  proposeInbound: false,                      // also propose as a candidate atom?
  inboundType: 'fact',                        // when proposeInbound=true
  inboundPhase: 1,
  linkedSymbols: [{ file: 'src/cli/preferences.ts', fn: 'getTheme' }],
  validFrom: new Date().toISOString(),
})

// → { vectorDocId: 'doc-abc123', conflicts: [...], inboundPath?: '...' }
```

**What `retain` does, end-to-end:**

1. Resolve effective namespace (call > store default > empty).
2. Embed `content` once via the configured `Embedder`.
3. Search same-namespace vectors at threshold ≥ `conflictThreshold`
   (default 0.92) — predecessors that may be semantic duplicates.
4. Apply `conflictPolicy`:
   - `auto` — heuristic: identical content text invalidates predecessor
   - `supersede` — invalidate every match above threshold
   - `coexist` — keep both, only flag the conflict
5. Write the new doc with stamped `valid_from`, optional `supersedes`,
   and namespace fields applied via `applyNamespace()`.
6. Patch invalidated predecessors (`patchMetadataMany`) — set their
   `valid_to = now` and `superseded_by = doc.id`.
7. Optionally propose to inbound queue (one `.md` file under
   `<root>/.brain/.../inbound/`) — never writes to `gks/` directly.
8. Emit `audit.retain` event with `doc_id`, conflict count,
   invalidation count.
9. Increment OTel counter `gks.retain.docs` with backend + has_conflict
   labels.

**Single-embed optimisation:** the embedding is computed once at step 2
and reused for both conflict detection (step 3) and the new doc (step 5).

### 4.2 `recall` — read facts

```ts
import { recall } from '@evaai/gks'

const result = await recall(store, 'how does dark mode work?', {
  strategy: 'multi',                          // atomic | vector | episodic | obsidian | multi
  topK: 10,
  scoreThreshold: 0.35,
  namespace: { tenant_id: 'acme' },
  crossNamespace: false,                      // admin opt-out from namespace filter
  boostStable: true,                          // +0.05 for status=stable hits
})

// → {
//     query, hits: [{ id, source, score, path, title, snippet, metadata }, ...],
//     strategy, tookMs
//   }
```

**The default strategy is `multi`:** parallel fan-out to all enabled
sources (vector + atomic by ID heuristic + episodic by file scan +
obsidian via adapter). Then:

1. Each source returns hits with normalised `(id, source, score,
   path?, title?, snippet, metadata?)` shape.
2. **Dedup** by `(path \|\| id)` — keep the highest score per key.
3. **Status boost** — add `STABLE_BOOST` (= 0.05) to hits whose
   `metadata.status === 'stable'`. Promotes canonical / promoted notes
   above raw scrape results.
4. **Optional rerank pass** (when `MemoryStoreOptions.reranker` is
   configured): blend the first-pass score with the reranker's score
   via `final = (1 - alpha) * first + alpha * reranker`. Default
   `alpha=0.6`, default reranker is BM25-lite (zero-deps, always
   available); HTTP cross-encoder backend is opt-in.
5. **Cap** at `maxTotal` (default 10).
6. Emit `audit.recall` (with truncated query text, hit count,
   strategy) and OTel histograms (`gks.recall.latency_ms`,
   `gks.recall.hits`).

**Snippet trust boundary:** `RetrievalHit.snippet` is sourced from
user-controlled memory. When piped into a downstream LLM prompt, frame
it explicitly (e.g. "RETRIEVED CONTENT BEGIN/END" markers) so an
attacker-planted note can't override the agent's instructions. Both
the JSDoc and the MCP tool description for `gks_recall` flag this
explicitly.

### 4.3 `reflect` — consolidate a session

```ts
import { reflect } from '@evaai/gks'

const result = await reflect(store, {
  sessionId: 'MSP-SESS-260426ABCD',
  startedAt: '2026-04-26T10:00:00Z',
  endedAt: '2026-04-26T11:30:00Z',
  participants: ['MSP-USR-BOSS', 'MSP-AGT-RWANG-IDE'],
  trace: traceSteps,                          // TraceStep[]
}, {
  forceConsolidate: false,                    // override min-message threshold
  persist: true,                              // write the EpisodicMemory file
})

// → {
//     triggered: true,
//     memory: EpisodicMemory,
//     proposals: InboundArtifact[],
//     inboundPaths: string[],
//   }
```

**The Consolidator pipeline** (deterministic Three-Gate per ADR-002 +
pluggable LLM extraction):

1. **Extract** — pluggable `SummaryExtractor`. Default heuristic
   produces `{ summary, tags, outcomes, emotionSummary, linkedAtoms,
   proposals[] }`. LLM-backed extractor (Anthropic Sonnet 4.6 by
   default) produces calibrated proposals when `ANTHROPIC_API_KEY` is
   set; falls back to heuristic on parse failure.
2. **Three-Gate scoring** — per proposal:
   `composite = clamp01(confidence) × clamp01(refCount/5) × clamp01(recency)`.
   Keep proposals where `composite ≥ 0.45` (configurable).
3. **Write episodic** — `EpisodicLayer.writeEpisodic(memory)` produces
   `<sessionId>.md` (overwrite-refusing).
4. **Propose surviving atoms** — each kept proposal lands in the
   inbound queue as `<id>.<reviewId>.md` with namespace stamped in
   frontmatter. A human / orchestrator promotes them into `gks/` later.

**Why deterministic scoring stays deterministic:** the LLM proposes
candidates; the Three-Gate decides what survives. This means an
adversarial LLM can't manipulate retention by inflating `confidence` —
the value is clamped at the extractor edge, then re-clamped at the
gate (security pass, ADR-006 / 3.5.1).

### 4.4 Helper verbs

```ts
// Exact-id atomic lookup — never hallucinates.
const note = await store.lookup('CONCEPT--EVA-TRI-BRAIN')

// Reverse citation lookup — given a code path, find atoms that govern
// it. Closes the bidirectional traceability loop with code-intelligence
// peers like GitNexus (ADR-010).
const atoms = await store.lookupBySymbol('src/memory/inbound.ts:propose')

// Direct inbound write (only authorised path to candidate atoms).
const receipt = await store.proposeInbound({
  proposed_id: 'INSIGHT--USER-PREFERS-DARK',
  phase: 1, type: 'insight',
  title: '...', body: '...',
  linked_symbols: [...],
})

// Append a session trace step (during the session, before reflect).
await store.episodic.appendTrace(sessionId, {
  kind: 'user', content: 'help me debug X',
})
```

`lookup` and `lookupBySymbol` both write to the audit log. `lookup`
treats atomic notes as **global by design** — they're the canonical,
shared knowledge tree, not tenant-private storage.

---

## 5. Bi-temporal model

ADR-002 records the decision; this section is the operational
reference.

### 5.1 The two timelines

Every retained doc carries:

| Field | Meaning |
|---|---|
| `valid_from` | when the fact became true in the world |
| `valid_to` | when it stopped being true (`null` ⇒ still valid) |
| `superseded_by` | the doc id that replaced this one (when set) |
| `created_at` | when the doc was *recorded* (filesystem time) |

This is the **bi-temporal** classic split: "valid time" (when the fact
was true in reality) vs "transaction time" (when we recorded it). GKS
uses `valid_from` / `valid_to` for valid time and ordinary file mtime
for transaction time.

### 5.2 What this enables

```ts
// Time-travel query — what did the agent know on 2026-01-15?
const result = await recall(store, 'pricing rules', {
  asOf: '2026-01-15T00:00:00Z',
})
```

(`asOf` is supported on both vector search and graph traversal — the
same predicate
`tstzrange(valid_from, COALESCE(valid_to, 'infinity'), '[)') @> $asOf`
is applied at the SQL layer for `PgvectorBackend` / `PgGraphBackend`,
and an in-memory equivalent for JSONL.)

### 5.3 Conflict policies

When `retain` finds same-namespace cosine matches above
`conflictThreshold` (default 0.92), the configured `conflictPolicy`
decides:

| Policy | Behaviour |
|---|---|
| `auto` (default) | Heuristic. If the new content text is identical to a match (after trim/normalise), supersede it; otherwise log the conflict and keep both. |
| `supersede` | Always invalidate every match above threshold; new doc carries `supersedes` pointing at the most recent. |
| `coexist` | Keep both, only flag the conflict in the response. Useful when both can be true simultaneously (e.g. parallel revisions of a list). |

**Namespace-scoped:** conflict detection only considers same-namespace
docs. Tenant A's retain cannot supersede tenant B's docs even by
accident (regression fix in ADR-004 — was a real cross-tenant bug
latent in earlier code).

### 5.4 Reverse citation lookup integration

`linked_symbols` and `geography` fields participate in the bi-temporal
model: `searchBySymbol(path)` returns atoms that *currently* cite the
given path. To ask "which atoms cited this path before Q1 refactor?",
filter the result by `valid_from` / `valid_to`:

```ts
const cited = await store.lookupBySymbol('src/old/api.ts:legacy')
const onDate = cited.filter((e) =>
  (!e.valid_from || e.valid_from <= '2026-01-15') &&
  (!e.valid_to || e.valid_to > '2026-01-15')
)
```

ADR-010 details the full match semantics.

---

## 6. Multi-tenancy via Namespace

ADR-004 records the decision; this section is the day-to-day reference.

### 6.1 The Namespace type

```ts
interface Namespace {
  tenant_id?: string                  // SaaS tenant
  user_id?: string                    // user within tenant
  session_id?: string                 // session within user
  agent_id?: string                   // agent within session
}
```

All four fields optional. An empty `{}` means "global / default
tenant" — fine for single-tenant agents.

### 6.2 How it threads through the system

| Operation | Default scope | Override |
|---|---|---|
| `retain` | call's `namespace` > store's `defaultNamespace` > `{}` | per-call `namespace` |
| `recall` | same | per-call `namespace` or `crossNamespace: true` (admin) |
| Conflict resolution (`supersede`) | active namespace only | n/a — namespace-scoped by construction |
| Audit log | active namespace stamped on every event | n/a — always recorded |
| MCP `gks_recall_cross_namespace` | bypasses filter (gated by `exposeCrossNamespace: true`) | admin tool, off by default |

### 6.3 Typical patterns

**Single-tenant CLI agent** — set nothing:

```ts
const store = new MemoryStore({ root: '.' })
// All retains / recalls live in the global namespace.
```

**Per-tenant SaaS** — one `MemoryStore` instance per request,
scoped at construction:

```ts
function storeForRequest(req: Request) {
  return new MemoryStore({
    root: '/data',
    defaultNamespace: { tenant_id: req.tenantId },
    embedder: sharedEmbedder,
    cost: { attrs: { tenant_id: req.tenantId } },
  })
}
```

The construction is cheap (lazy embedder + lazy vector store), so
per-request instances are fine.

**Per-session agent loop** — refine at the call site:

```ts
await retain(store, {
  content: '...',
  namespace: { tenant_id: 'acme', user_id: 'alice', session_id: 'sess-123' },
})
```

### 6.4 Cross-tenant access — the explicit opt-out

```ts
// Reading across tenants — admin / analytics paths only.
const result = await recall(store, 'payment failures', {
  crossNamespace: true,
})
// Audit log records `meta.cross_namespace = true` so anomalies show
// up in post-hoc review.
```

The MCP server gates this behind a separate tool
(`gks_recall_cross_namespace`) that's only registered when
`exposeCrossNamespace: true` is passed at server construction. Default
is off — the audit footprint of an accidental cross-tenant query is
lower if the tool isn't even visible.

---

## 7. Pluggable backends — extension points

Six plugin points. All have working defaults; swap any of them at
`MemoryStore` construction without touching the verbs.

### 7.1 `VectorBackend`

```ts
interface VectorBackend {
  readonly name: string
  ensureLoaded(): Promise<void>
  addItem(args: VectorBackendAddItem): Promise<VectorDoc>
  search(query: string | number[], opts?: VectorSearchOptions): Promise<VectorHit[]>
  patchMetadataMany(updates: Array<{ id: string; patch: Partial<VectorMetadata> }>): Promise<void>
  listDocs(): VectorDoc[]
  getManifest(): VectorManifest
  // …
}
```

Three shipped: `VectorStore` (JSONL), `HnswBackend`, `PgvectorBackend`.
`VectorBackendFactory = (name, embedder) => VectorBackend` — passed to
`MemoryStoreOptions.vectorBackend`.

### 7.2 `GraphBackend`

```ts
interface GraphBackend {
  load(): Promise<void>
  addNode(args: AddNodeArgs): Promise<GraphNode>
  addEdge(args: AddEdgeArgs): Promise<GraphEdge>
  query(q?: GraphQuery): GraphEdge[] | Promise<GraphEdge[]>
  neighbors(seed: string, q?: NeighborQuery): NeighborResult[] | Promise<NeighborResult[]>
}
```

Two shipped: `GraphStore` (in-memory, JSONL persistence),
`PgGraphBackend` (Postgres tables — replaced FalkorDB plan per ADR-005).

**Per ADR-009:** the Graph layer is for **atom-level relationships**
(note ↔ note backlinks, ADR ↔ FEAT references, supersede chains) — not
code-level call graphs. Code graphs belong in a peer subsystem like
GitNexus; sync code edges into `GraphBackend` is allowed (ADR-009
denormalisation pattern, see `examples/gitnexus-graph-cache/`) but GKS
imports nothing from GitNexus.

### 7.3 `Reranker`

```ts
interface Reranker {
  readonly name: string
  rerank(query: string, hits: RetrievalHit[], opts?: { limit?: number }): Promise<RerankerScore[]>
}
```

Three shapes: BM25-lite (default, zero-deps, lexical), HTTP cross-encoder
(opt-in, requires endpoint — wire e.g. BGE rerank-v2 via TEI), or a
custom function. Configure via `MemoryStoreOptions.reranker`:

```ts
new MemoryStore({
  reranker: {
    backend: 'http',
    endpoint: 'http://rerank.local:8080/score',
    alpha: 0.6,
    normalize: true,
    limit: 20,
  },
})
```

Pass `enabled: false` to disable entirely.

### 7.4 `LlmClient`

Used by the LLM-backed Consolidator (`reflect`). Single-method:

```ts
interface LlmClient {
  readonly name: string
  generate(args: { system: string; user: string; maxTokens?: number }): Promise<string>
}
```

Default `createAnthropicClient()` calls Anthropic Messages API directly
(no SDK dep — `fetch` only). Auto-records usage via `CostTracker`. The
Consolidator uses the LLM to *propose* candidate atoms; it never
delegates Three-Gate scoring to the LLM — that stays deterministic.

### 7.5 `ObsidianAdapter`

Two shipped (`RestObsidianAdapter`, `MCPObsidianAdapter`) and a
deterministic mock for tests. Common interface (see §3.4). Cache is
applied at the `MemoryStore` boundary, not inside the adapter, so a
custom adapter doesn't have to implement caching.

### 7.6 `Embedder`

```ts
interface Embedder {
  readonly provider: 'ollama' | 'openai' | 'mock' | (string & {})
  readonly model: string
  readonly dimension: number
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}
```

Auto-detection logic (`createEmbedder`):

1. If `forceProvider` set, use that.
2. Try Ollama at `OLLAMA_BASE_URL` (default `http://localhost:11434`)
   with `OLLAMA_EMBED_MODEL` (default `bge-m3`).
3. Try OpenAI if `OPENAI_API_KEY` is set.
4. Fall back to deterministic SHA-256 mock (384 dim) — tests + offline.

`wrapEmbedderWithCostTracker(embedder, tracker, attrs)` adds usage
records on every call without changing the surface.

### 7.7 Composition example

```ts
import {
  MemoryStore, createPgvectorBackend, createPgGraphBackend,
  createRestObsidianAdapter, createReranker,
  createEmbedder, wrapEmbedderWithCostTracker,
  CostTracker,
} from '@evaai/gks'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] })
const cost = new CostTracker()
const embedder = wrapEmbedderWithCostTracker(
  await createEmbedder({ forceProvider: 'ollama' }),
  cost,
  { tenant_id: 'acme' },
)
const obsidian = createRestObsidianAdapter({
  baseUrl: 'http://127.0.0.1:27123',
  apiKey: process.env['OBSIDIAN_KEY'],
})

const store = new MemoryStore({
  root: '/data',
  defaultNamespace: { tenant_id: 'acme' },
  embedder,
  vectorBackend: (name, e) => createPgvectorBackend({ pool, name, embedder: e }),
  obsidian,
  reranker: { backend: 'http', endpoint: process.env['RERANK_URL'] },
  cost: { attrs: { tenant_id: 'acme' } },
})
await store.init()
```

Every layer here is the production option. Strip back to JSONL +
in-process graph + BM25-lite for dev.

---

## 8. Surfaces — MCP server + CLI

GKS ships two surfaces beyond the TS API: an MCP server (for any
MCP-aware client — Claude Code, Cursor, custom agents) and a CLI
(`npx gks`) for terminal use.

### 8.1 MCP server

`bin/gks-mcp-server.ts` — stdio-only transport per ADR-007 (HTTP
deferred). Eight tools:

| Tool | Verb | Purpose |
|---|---|---|
| `gks_retain` | write | retain a fact, optionally proposeInbound |
| `gks_recall` | read | multi-source retrieval |
| `gks_lookup` | read | exact-id atomic lookup |
| `gks_lookup_by_symbol` | read | reverse citation lookup (ADR-010) |
| `gks_propose_inbound` | write | candidate atom into inbound queue |
| `gks_reflect` | read+write | run Consolidator on a session |
| `gks_recall_cross_namespace` | read (admin) | bypass namespace filter (gated by `exposeCrossNamespace: true`) |

Each tool uses Zod-strict input schemas; the SDK enforces them before
the handler runs. JSON replies are serialised in a `text` content block
so non-MCP clients can `JSON.parse` the body.

**Setup:**

```jsonc
// ~/.config/claude/mcp.json (or your client's equivalent)
{
  "mcpServers": {
    "gks": {
      "command": "npx",
      "args": [
        "gks-mcp-server",
        "--root=/path/to/data",
        "--tenant=alice",
        "--user=alice@example.com",
        "--hnsw"                    // or --pg --pg-url=postgres://...
      ]
    }
  }
}
```

**Pairing with code-intelligence peers** (per ADR-009): run a
GitNexus-like server *next to* GKS, not chained underneath. Both
servers register their tools to the same MCP client; the client (or a
Memory OS layer) picks the right tool per question. GKS imports
nothing from peer subsystems — see `docs/MSP_RELATIONSHIP.md` for the
worked example.

### 8.2 CLI — `npx gks`

`bin/gks.ts` — a thin wrapper over `MemoryStore` / `IssueStore` /
`api.ts` for ad-hoc terminal use.

**Memory verbs:**

```sh
gks init                                   # scaffold .brain/ + gks/00_index/
gks retain "User prefers dark mode"
gks recall "tri-brain architecture" --top-k=5 --strategy=multi
gks lookup CONCEPT--EVA-TRI-BRAIN
gks lookup-by-symbol src/memory/inbound.ts:propose
gks propose-inbound INSIGHT--FOO --title="…" --body="…" \
    --linked-symbol=src/x.ts:fn:42
gks reflect MSP-SESS-260426ABCD
gks status
```

**Doc-to-code enforcement (ADR-014, 3.5.5):**

```sh
gks new-feature rate-limit --title="Per-tenant rate limit" \
    --concept="Why" --adr="What we picked" \
    --blueprint-file=src/api/rl.ts --blueprint-file=src/db/quota.ts \
    --task=validate-input --task=error-mapper --task-tracker=local
                                          # drops 4 atoms into inbound;
                                          # microtasks (--task-tracker=local) go to .brain/<ns>/tasks/
                                          # (msp/external trackers print guidance instead — ADR-015)
gks verify-flow FEAT--RATE-LIMIT          # walk crosslinks; exit-1 on broken chain
gks validate --links                      # crosslink integrity over all atoms
gks hotfix open <full-sha> --title="prod down" --file=src/api/rl.ts
gks hotfix list [--overdue] [--pending]
gks hotfix close HOTFIX--ABC1234 --resolved-by=ADR--RATE-LIMIT-FIX
gks hotfix check --file=src/api/rl.ts     # pre-commit gate; exit-1 if 48h window passed
```

**Issue tracker (ADR-012, 3.5.4):**

```sh
gks issue new "Recurring OOM" --priority=high --label=perf
gks issue list                          # active issues only by default
gks issue list --status=all
gks issue show ISSUE--RECURRING-OOM
gks issue comment ISSUE--RECURRING-OOM "reproduction confirmed"
gks issue assign ISSUE--RECURRING-OOM MSP-AGT-RWANG
gks issue status ISSUE--RECURRING-OOM in_progress
gks issue close  ISSUE--RECURRING-OOM --resolved-by=ADR--CIRCUIT-BREAKER
gks issue dashboard --md
```

**Global flags** (apply to every subcommand):

| Flag | Effect |
|---|---|
| `--root=PATH` | Repo root. Default `cwd` or `$GKS_ROOT`. |
| `--tenant=ID` | Set `defaultNamespace.tenant_id` |
| `--user=ID` | Set `defaultNamespace.user_id` |
| `--agent=ID` | Set `defaultNamespace.agent_id` |
| `--provider=auto\|ollama\|openai\|mock` | Embedder provider override |
| `--json` | Machine-readable output instead of pretty text |

**Stdin support:** `gks retain` and `gks recall` accept content/query
via stdin when no positional argument is given. Useful for piping:

```sh
git diff --name-only | xargs -I{} gks lookup-by-symbol {} --json | jq
```

### 8.3 Operational scripts

`package.json` exposes a few scripts beyond the verbs:

```sh
npm run msp:index      # rebuild gks/00_index/atomic_index.jsonl from gks/**/*.md
npm run re-embed       # incremental re-embed when source files change
npm run pg-migrate     # apply pgvector / pg-graph SQL migrations
npm run gks-migrate    # forward-migrate vector store schema versions
```

The re-indexer (`scripts/msp/re-indexer.ts`) is what gives the atomic
layer its data — see ADR-010 + the 3.5.3 release note for why it ships.

---

## 9. Cross-cutting concerns

### 9.1 Audit log

`src/memory/audit.ts:AuditLog` — append-only JSONL, daily-rotated.

**Where:** `<root>/.brain/msp/projects/evaAI/audit/audit-YYYY-MM-DD.jsonl`
(filename rotates by UTC day; no deletion logic in GKS — operators can
ship to S3 / cold storage).

**What gets logged:**

| Op | Fields recorded |
|---|---|
| `retain` | namespace, doc_id, conflicts, invalidated, optional inbound_path |
| `recall` | namespace, query (truncated to 200 chars), hit_count, strategy |
| `lookup` | doc_id, found |
| `lookup_by_symbol` | symbol path, hit_count |
| `propose_inbound` | proposed_id, review_id, namespace |
| `write_episodic` | session_id |
| `patch_metadata` | doc_id, patch keys |
| `issue_create` / `issue_comment` / `issue_status_change` / `issue_assign` / `issue_close` | issue id, actor, transition |

**Best-effort emit:** disk-full / permission errors are caught + logged
to `createLogger('audit')` but never propagate to the caller. SOC2-style
audits care about visibility, not transactional gating.

**Pluggable sink:** `AuditLogOptions.onEvent` runs after the JSONL
append. Ship to Splunk / Datadog / similar without monkeypatching:

```ts
new MemoryStore({
  audit: {
    onEvent: (event) => splunkClient.send(event),
  },
})
```

### 9.2 Cost tracker

`src/lib/cost-tracker.ts:CostTracker` — per-(provider, model) token +
USD tally.

**Records:** `inputTokens`, `outputTokens`, computed `cost_usd` from
`pricing.ts` table (Anthropic, OpenAI, Ollama; defaults editable). Free
attrs (e.g. `tenant_id`, `session_id`) tag every entry.

**Snapshot:** `tracker.snapshot()` returns `{ total, by_model[], records[] }`.
`endSession(store, sessionId)` flushes the per-session snapshot into the
session's `session.json` so you can answer "how much did this session
cost?" without aggregating logs.

**Configure:**

```ts
new MemoryStore({
  cost: {
    pricing: customPricingTable,
    attrs: { tenant_id: 'acme' },
  },
})
```

Pass `cost: false` to disable entirely (fine for offline tests).

### 9.3 Observability — OpenTelemetry façade

`src/lib/telemetry.ts` — no-op by default. Zero tax when no SDK is
registered.

**Spans:** `gks.retain`, `gks.recall`, `gks.embed`, `gks.rerank.http`.
**Histograms:** `gks.recall.latency_ms`, `gks.embedder.latency_ms`,
`gks.rerank.latency_ms`. **Counters:** `gks.retain.docs`, `gks.cache.hits`,
`gks.cache.misses`, `gks.circuit.opens`.

**Lazy instrument resolution:** counters/histograms are looked up via
`metrics.getMeter()` on every emit (not cached at module load). If a
user registers a `MeterProvider` *after* GKS imports, they don't lose
emits. The OTel SDK caches by `(name, meter)` internally, so the
per-call cost is a Map lookup.

**Opt-in OTLP:** `setupTelemetry()` (in `src/lib/telemetry-setup.ts`)
wires `@opentelemetry/sdk-node` + OTLP HTTP exporters when called.
Keeps the heavy deps as `devDependencies` until the user wants them.

```ts
import { setupTelemetry } from '@evaai/gks/telemetry-setup'
setupTelemetry({ serviceName: 'gks', otlpEndpoint: 'http://otel:4318' })
```

Full setup walkthrough in `docs/OBSERVABILITY.md`.

### 9.4 Resilience primitives

`src/lib/retry.ts` and `src/lib/circuit-breaker.ts` — small, opinionated.

**Retry** — exponential backoff with full jitter, label-aware:

```ts
withRetry(async () => fetch(...), {
  label: 'anthropic-messages',
  maxAttempts: 4,
  baseMs: 250,
  capMs: 8_000,
  isRetryable: defaultIsRetryable,    // 5xx + 429 + network only — not 4xx
})
```

`defaultIsRetryable` is composed from `extractHttpStatus(err)` +
`isNetworkError(err)`. Auth failures (401, 403) never retry.

**Circuit breaker** — per-provider, half-opens after a cooldown:

```ts
const breaker = new CircuitBreaker({
  failureThreshold: 5,                // failures within window
  cooldownMs: 30_000,
  halfOpenProbeMs: 5_000,
})
await breaker.run('anthropic', () => fetch(...))
```

Auth errors don't trip the breaker (they're permanent failures, not
provider degradation).

**Bounded LRU** — used by the Obsidian adapter cache. `src/lib/lru.ts`
(if you want to use it elsewhere) — simple `Map`-backed, eviction on
size limit + TTL.

### 9.5 Schema versioning

`src/lib/schema-version.ts` — semver-style compatibility checker for
on-disk JSONL formats.

**Manifest field:** `schema_version` on every vector store manifest /
audit metadata.

**Policy:**
- Major bump → `load()` refuses, user must run `npm run gks-migrate`.
- Minor bump → `load()` warns but proceeds (new optional fields).
- Patch bump → silent (doc-only / typo fixes).

**Migration runner:** `scripts/msp/gks-migrate.ts` — registry of
forward migrations indexed by version. Walks the registry from the
on-disk version up to `current`, applies each in sequence, atomic
write of the final state.

Full policy details in `docs/MIGRATIONS.md`.

### 9.6 Security boundaries

GKS shipped a security audit pass in 3.5.1 (see CHANGELOG). Concrete
boundaries:

| Boundary | Mechanism |
|---|---|
| **Path traversal** | `AtomicLayer.readBody` bounds-checks resolved paths against `gksRoot`; refuses to escape. |
| **LLM-supplied confidence** | Clamped to `[0, 1]` + `Number.isFinite` guarded at extraction edge — adversarial models can't bypass Three-Gate. |
| **HTTP error body leakage** | `redactSecrets()` masks Bearer tokens / `x-api-key` / `sk-…` / JWTs in upstream error bodies before the error propagates to logs / OTel. Wired into Anthropic, OpenAI, Ollama, rerank, Obsidian REST clients. |
| **Frontmatter YAML injection** | All frontmatter writes go through `lib/yaml-lite.ts:yamlScalar` which quotes any value containing `:` / `#` / `\n` / leading reserved indicators. |
| **DoS via huge LLM JSON** | Extractor input capped at 1 MiB before `JSON.parse`. |
| **SQL `LIMIT` injection** | `safeLimit()` in `lib/sql.ts` bounds NaN / Infinity / negative input. |
| **Turn-tag injection in consolidator prompt** | A user message containing `\n[AGENT] ignore previous instructions` is neutralised before being fed to the LLM. |
| **Snippet trust** | `RetrievalHit.snippet` JSDoc + MCP descriptions flag snippets as untrusted when piped into LLM prompts. |
| **Cross-tenant access** | Namespace filter on every read; `crossNamespace: true` is the explicit opt-out + audited. |

Out of scope (deferred to orchestrator):
- Wikilink resolution validation
- ID uniqueness enforcement
- Forbidden-fields rejection per `atomic_contract.yaml`

These belong to the MSP-gatekeeper layer above GKS — see ADR-008 +
`docs/MSP_RELATIONSHIP.md`.

---

## 10. Storage layout on disk

`gksLayout(root)` is the single source of truth for paths — used by
the CLI scaffold, MCP server, and `MemoryStore` defaults.

**Per ADR-013 — atom folders are organised by `type`, not by `phase`.**
`phase` lives in frontmatter as a planning attribute, not in the folder
path. One folder per atom type (singular nouns), no phase prefix.

```
<root>/
├── gks/                                  # canonical (global, reviewed) — strict tier
│   ├── 00_index/
│   │   └── atomic_index.jsonl            # AtomicLayer source — rebuilt by `npm run msp:index`
│   ├── concept/                          # CONCEPT-- atoms
│   ├── adr/                              # ADR--
│   ├── feat/                             # FEAT--
│   ├── algo/                             # ALGO--
│   ├── flow/                             # FLOW--
│   ├── entity/                           # ENTITY--
│   ├── frame/                            # FRAME--
│   ├── parameters/                       # PARAMS--
│   ├── module/                           # MOD--
│   ├── blueprint/                        # BLUEPRINT-- (.yaml)
│   ├── audit/                            # AUDIT--
│   ├── skill/                            # SKILL--      (ADR-012 cluster)
│   ├── protocol/                         # PROTOCOL--
│   ├── guardrail/                        # GUARDRAIL--
│   ├── policy/                           # POLICY--
│   ├── persona/                          # PERSONA--
│   ├── fr/                               # FR--          (ADR-012 RE cluster)
│   ├── nfr/                              # NFR--
│   ├── constraint/                       # CONSTRAINT--
│   ├── inc/                              # INC--          (ADR-012 ops cluster)
│   ├── risk/                             # RISK--
│   ├── runbook/                          # RUNBOOK--
│   ├── slo/                              # SLO--
│   └── issues/                           # ISSUE-- atoms — light-tier (ADR-012)
│
└── .brain/msp/projects/evaAI/            # per-deployment runtime state
    ├── vector/                           # vector store JSONL / HNSW / pgvector cache
    ├── session/                          # live trace JSONL (append-only)
    │   └── <sessionId>.trace.jsonl
    ├── memory/                           # episodic summaries (one file per session)
    │   └── <sessionId>.md
    ├── inbound/                          # candidate atoms awaiting human promotion
    │   └── <PROPOSED-ID>.<reviewId>.md
    └── audit/                            # daily-rotated audit log
        └── audit-YYYY-MM-DD.jsonl
```

**Two rooted spaces**, intentional:

- `gks/` — git-tracked, human-reviewed, the SSOT. Strict-tier atoms
  flow through the inbound queue → human review → promote.
- `.brain/...` — runtime state, mostly machine-generated. Most of
  `.brain/` should be `.gitignore`d (see the project's `.gitignore`).

`gks/issues/` is the only directory in `gks/` that's light-tier — direct
write OK per ADR-012.

---

## 11. Boundaries — what GKS leaves to others

### 11.1 Memory OS layer (above)

ADR-008 records the contract; quick summary:

| Concern | Owner |
|---|---|
| Consolidation timing (when to fold sessions into long-term) | Memory OS |
| Importance / RI level filtering at write time | Memory OS |
| Sandbox / Origin-Buffer separation | Memory OS |
| Affect / emotion / RMS scoring | Memory OS plugin |
| Schema validation against `atomic_contract.yaml` | Memory OS / MSP gatekeeper |
| ID uniqueness enforcement | Memory OS / MSP gatekeeper |
| Wikilink resolution | Memory OS / MSP gatekeeper |
| Promote workflow (inbound → `gks/`) | Memory OS / MSP gatekeeper |

GKS's `proposeInbound()` is the *only* authorised write path to
`gks/`-destined atoms; the MSP-style gatekeeper above implements the
rest.

Reference Python implementation: `examples/memory-os-architecture/` —
shows a paradigm-agnostic Memory OS kernel + EVA-specific affect plugin
+ storage adapter that delegates to GKS.

### 11.2 Code-intelligence peer (alongside)

ADR-009 records why GitNexus (or any code-AST engine) sits *next to*
GKS, not chained underneath:

```
              ┌─── MSP / orchestrator ──┐
              ▼                          ▼
            GKS                      GitNexus
            (atoms + episodic        (AST + call graph)
             + vector + obsidian)
```

GKS imports nothing from GitNexus. The orchestrator above (e.g. MSP)
holds clients for both and merges results when needed. ADR-010's
`linked_symbols` is the cross-reference primitive — atoms cite code
paths; the orchestrator dereferences via GitNexus.

Allowed denormalisation: cache GitNexus call edges into GKS's
`GraphBackend` for fast reads. Worked example in
`examples/gitnexus-graph-cache/`. The cache is not a runtime
dependency — GKS treats the rows as ordinary data.

Drift-detection application: `examples/drift-detection/` shows how an
orchestrator combines `lookupBySymbol` (atoms citing changed code)
with the cached call graph (downstream callers) into a pre-push gate.

### 11.3 Workflow / governance / phase gates

Out of scope per ADR-008. CI / process-tooling layer:
- Phase-gate enforcement (doc-before-code) — pre-commit hook
- Microtask codegen / composer — separate tool
- Engineering laws (file size limits, repository pattern) — eslint
- Multi-agent git strategy — process rule

These live in the consuming project's CI / tooling, not in GKS.

---

## 12. Configuration matrix

### 12.1 Environment variables

| Var | Purpose | Default |
|---|---|---|
| `GKS_ROOT` | Default repo root for the CLI | `cwd` |
| `GKS_EMBEDDER` | `mock` / `ollama` / `openai` | auto-detect |
| `GKS_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `OLLAMA_BASE_URL` | Ollama server | `http://localhost:11434` |
| `OLLAMA_EMBED_MODEL` | Ollama embedding model | `bge-m3` |
| `OPENAI_API_KEY` | OpenAI access key | — |
| `OPENAI_EMBED_MODEL` | OpenAI embedding model | `text-embedding-3-small` |
| `ANTHROPIC_API_KEY` | Anthropic for LLM Consolidator | — |
| `ANTHROPIC_BASE_URL` | Anthropic API base | `https://api.anthropic.com` |
| `ANTHROPIC_CONSOLIDATOR_MODEL` | Consolidator model | `claude-sonnet-4-6` |
| `DATABASE_URL` | Postgres for pgvector / pg-graph | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector | — (no-op default) |

### 12.2 `MemoryStoreOptions` — the master config bag

See `src/memory/index.ts`. Most-used:

- `root` — repo root (required)
- `defaultNamespace` — request-scoped tenant/user/agent
- `embedder` / `embedderOptions` — pre-built or factory
- `vectorBackend` — `(name, embedder) => VectorBackend`
- `vectorScoreThreshold` — default cutoff (0.35)
- `maxTotal` — recall result cap (10)
- `reranker` — config object or `{ enabled: false }`
- `obsidian` — adapter or omit
- `obsidianCacheTtlSeconds` / `obsidianCacheMaxEntries` — cache knobs
- `audit` — `{}` to enable defaults / `false` to disable
- `cost` — `{}` to enable / `false` to disable

---

## 13. Performance characteristics

Order-of-magnitude figures from local dev runs (Node 22, M-series, mock
embedder where relevant):

| Operation | Backend | Latency | Notes |
|---|---|---|---|
| `lookup(id)` | Atomic | < 1 ms | hot Map; cold first call ~5 ms (file read) |
| `lookupBySymbol` | Atomic | O(N) over index, ~5 ms for 1k atoms | linear scan; inverted index TBD if it matters |
| `recall (vector only)` | JSONL | ~5 ms per 1k docs | brute-force cosine |
| `recall (vector only)` | HNSW | < 1 ms for 100k docs | log-N |
| `recall (vector only)` | pgvector | 5-20 ms for 1M docs | depends on `ef_search` |
| `recall (multi)` | all 4 layers | parallel: max(layer latency) + merge ~1 ms | not sum |
| `retain` | JSONL | ~10 ms (embed + write) | mock embedder |
| `retain (with conflict scan)` | pgvector | ~30-50 ms | one transaction round-trip |
| `reflect` (heuristic) | — | < 100 ms for 200-message session | no LLM call |
| `reflect` (LLM) | Anthropic | 2-10 s | Sonnet latency dominated |

Scaling ceilings:
- **JSONL vector** — comfortable up to ~10k docs / store; beyond that
  switch to HNSW or pgvector.
- **In-memory `GraphStore`** — comfortable up to ~10k nodes; beyond
  that use `PgGraphBackend`.
- **Atomic index** — comfortable up to ~10k atoms (linear scan in
  `searchBySymbol`). At 100k atoms an inverted-index file would be
  appropriate; not built yet (see ADR-010 deferred work).

---

## 14. Release versioning

Semver-style: `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking architecture change (new ADR required).
- **MINOR** — additive feature (new MCP tool, new backend, new CLI command).
- **PATCH** — bug fix, security pass, doc-only, refactor.

Current shipped: `3.5.4`. Per-release notes in `CHANGELOG.md`.

`prepublishOnly` enforces `npm run typecheck && npm test && npm run build`
so every published tarball has both passing tests and a clean dist.

---

## 15. Reference architectures (`examples/`)

| Path | Demonstrates |
|---|---|
| `examples/quickstart.ts` | TS API end-to-end (retain → recall → bi-temporal supersede → temporal graph demo) |
| `examples/memory-os-architecture/` | Python POC: Memory OS kernel + EVA plugin + storage adapter (`JsonFile` and `Gks`-via-MCP) |
| `examples/gitnexus-graph-cache/` | TS adapter syncing GitNexus AST exports into GKS `GraphStore` (the ADR-009 denormalisation pattern) |
| `examples/drift-detection/` | TS pre-push gate combining `lookupBySymbol` + cached call graph; risk-classified report (HIGH / MEDIUM / LOW / NONE) |
| `examples/atom-templates/` | 17 starter `.md` templates per atomic prefix (ADR / FEAT / ALGO / SKILL / GUARDRAIL / FR / NFR / INC / ISSUE / RISK / RUNBOOK / SLO / …) |

---

## 16. Further reading

| Doc | Purpose |
|---|---|
| `README.md` | Quick start + install + minimal example |
| `SCOPE.md` | Explicit in/out scope + 5-question decision rule |
| `docs/MSP_RELATIONSHIP.md` | Why GKS pairs with MSP-shaped Memory OS layers + the contract |
| `docs/KNOWLEDGE-TYPES.md` | Canonical reference for all 30+ atomic prefixes |
| `docs/ARCHITECTURE.md` | Layer diagrams + sequence flows (companion to this overview) |
| `docs/OBSERVABILITY.md` | OTel collector wiring + dashboard cheat-sheet |
| `docs/MIGRATIONS.md` | Schema-version policy + migration runner |
| `docs/BENCHMARKS.md` | Running LoCoMo / LongMemEval / BEAM at real scale |
| `docs/adr/` | 12 Architecture Decision Records |

### ADR index

| # | Title |
|---|---|
| 001 | File-based vector store as Phase 1 default |
| 002 | Bi-temporal conflict resolution |
| 003 | Pluggable backend interfaces |
| 004 | Namespace as first-class isolation key |
| 005 | Cut FalkorDB; use Postgres tables |
| 006 | OpenTelemetry no-op default |
| 007 | MCP server: stdio only |
| 008 | GKS as storage engine; Memory OS layer above |
| 009 | MSP orchestrates peer subsystems; GKS does not proxy them |
| 010 | Bidirectional traceability via reverse citation lookup |
| 011 | Test policy |
| 012 | Extended atomic taxonomy + ISSUE-- as self-hosted tracker |
| 013 | Atom folders by type, not by phase |
| 014 | Doc-to-code enforcement model (master-spec §6 → GKS primitives) |
| 015 | Task tracking belongs to the orchestrator, not GKS |

---

## 17. Quick reference card

```
verbs:    retain · recall · reflect · lookup · lookupBySymbol · proposeInbound
layers:   atomic · vector · episodic · obsidian
extras:   IssueStore · HotfixStore (light-tier — ADR-012, ADR-014)
gates:    verifyFlow · validateLinks · scaffoldNewFeature (ADR-014)
plugins:  VectorBackend · GraphBackend · Reranker · LlmClient · ObsidianAdapter · Embedder
surfaces: TypeScript API · MCP server (8 tools) · CLI (npx gks)
ops:      audit · cost · OTel · retry · circuit-breaker · schema-version
backends: JSONL · HNSW · pgvector · Postgres-graph · Obsidian-REST · Obsidian-MCP-stdio
boundary: MSP / Memory OS above (ADR-008) · GitNexus alongside (ADR-009)

never inside GKS:
  - workflow / phase gates
  - AST / call graph
  - affect / consolidation timing
  - schema validation rules per consumer
  - cognitive / paradigm-specific concerns
```

