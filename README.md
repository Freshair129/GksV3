# GKS v3

> Genesis Knowledge System — a **storage engine** for agent memory:
> four cooperating layers (Atomic, Vector, Obsidian, Episodic) behind
> three verbs (Retain, Recall, Reflect), with multi-tenancy, bi-temporal
> versioning, observability, and pluggable backends.

[![tests](https://img.shields.io/badge/tests-321%20passing-brightgreen)](#tests)
[![node](https://img.shields.io/badge/node-%E2%89%A520-blue)](#requirements)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> 📐 **Scope:** GKS is a *storage engine*, not a Memory OS or workflow
> framework. It exposes primitives; consolidation timing, affect, and
> phase gates belong in layers above. See [`SCOPE.md`](./SCOPE.md) for
> the full in/out list.

GKS is a unified memory interface for agents — four cooperating layers
(Atomic, Vector, Obsidian, Episodic) accessed through three verbs
(Retain, Recall, Reflect), with first-class multi-tenancy, bi-temporal
versioning, observability, and pluggable backends.

```ts
import { MemoryStore, retain, recall } from '@freshair129/gks'

const store = new MemoryStore({ root: '.gks-data' })
await store.init()

await retain(store, { content: 'User prefers dark mode in the CLI.' })

const result = await recall(store, 'preferences', { topK: 5 })
console.log(result.hits)
```

## Why GKS

- **All four memory layers wired into a single `recall()`** — exact-id
  Atomic lookup, semantic Vector search, graph + fulltext via Obsidian,
  and per-session Episodic context, fused in parallel.
- **Bi-temporal facts** — when knowledge changes, the old version is
  retained with `valid_to` set; `recall(asOf: '2024-06-01')` travels
  back in time.
- **Multi-tenancy by construction** — every retain stamps a `Namespace`
  onto its doc; every recall filters by it; cross-tenant access is an
  explicit opt-in flag.
- **Production-ready** — retry + circuit breaker on every network call,
  OpenTelemetry traces + metrics on every hot path, append-only audit
  log, schema-versioned manifests, per-session token + USD tracking.
- **Pluggable everywhere** — swap JSONL for `pgvector` or `HNSW`, the
  in-memory graph for `PgGraphBackend`, BM25 for an HTTP cross-encoder,
  the heuristic Consolidator for an Anthropic-backed extractor — all
  without touching `retain` / `recall` / `reflect` callers.

## Requirements

- Node.js ≥ 20
- (optional) Postgres ≥ 14 + pgvector ≥ 0.5 — for `PgvectorBackend`
- (optional) Ollama with `bge-m3` — for the primary embedder
- (optional) An Anthropic API key — for the LLM-backed Consolidator

The defaults run in-process with zero external services, using a SHA-256
mock embedder; `setEmbedder()` to switch in a real one.

## Install

```sh
npm install @freshair129/gks
```

## Quickstart

```ts
import { MemoryStore, retain, recall } from '@freshair129/gks'
import { createEmbedder } from '@freshair129/gks/vector/embedder'

const embedder = await createEmbedder({ forceProvider: 'ollama' })
const store = new MemoryStore({
  root: '.gks-data',
  embedder,
  defaultNamespace: { tenant_id: 'acme' },
})
await store.init()

await retain(store, { content: 'Acme prefers all reports in markdown.' })
await retain(store, { content: 'Acme deploys on Tuesdays.' })

const out = await recall(store, 'when does acme deploy?', { topK: 3 })
for (const hit of out.hits) console.log(hit.score.toFixed(3), hit.snippet)
```

For a full walkthrough including bi-temporal supersede, the inbound
queue, session lifecycle, and a temporal graph demo, see
[`examples/quickstart.ts`](./examples/quickstart.ts) — runnable with
`npm run quickstart`.

## CLI

```sh
gks init                              # scaffold .brain/ tree
gks retain "preferred deploy day: Tue"
gks recall "deploy day"
gks lookup CONCEPT--EVA-TRI-BRAIN
gks status                            # store stats
```

## MCP server

GKS ships an MCP server so any MCP-aware client (Claude Code, Cursor,
custom agents) can use the memory fabric over stdio:

```jsonc
// ~/.config/claude/mcp.json
{
  "mcpServers": {
    "gks": {
      "command": "npx",
      "args": ["gks-mcp-server", "--root=/path/to/data", "--tenant=alice"]
    }
  }
}
```

12 tools exposed: `gks_retain`, `gks_recall`, `gks_lookup`,
`gks_propose_inbound`, `gks_reflect`, `gks_verify_flow`, `gks_validate_links`,
`gks_new_feature`, `gks_hotfix_open`, `gks_hotfix_list`, `gks_hotfix_close`,
plus an admin `gks_recall_cross_namespace` (gated). See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#layer-dependency).

### Pairing with a code-structure layer (e.g. GitNexus)

GKS is the **semantic / temporal memory** layer (atomic + vector +
episodic + obsidian). It deliberately does **not** parse source code into
ASTs or call graphs — that's a complementary concern best served by a
dedicated tool such as [GitNexus](https://github.com/nxpatterns/gitnexus),
which indexes a repo into a knowledge graph (functions, imports, call
chains, blast-radius) and exposes its own MCP tools (`query`, `impact`,
`detect_changes`, …).

Run them side-by-side — Claude Code merges the tool surfaces and an agent
gets both kinds of context in one prompt:

```jsonc
// ~/.config/claude/mcp.json
{
  "mcpServers": {
    "gks": {
      "command": "npx",
      "args": ["gks-mcp-server", "--root=/path/to/data", "--tenant=alice"]
    },
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

Recommended split:

| Question                                     | Tool         |
|----------------------------------------------|--------------|
| "What did we decide about X last week?"      | `gks_recall` |
| "Show me ADR-0007 verbatim."                 | `gks_lookup` |
| "What breaks if I refactor `parseTrace()`?"  | `impact`     |
| "Who calls `escapeCopyField`?"               | `query`      |
| "Map this PR's diff to affected processes."  | `detect_changes` |

**Architectural note:** GKS has no knowledge of GitNexus — no import,
no proxy, no fan-out tool. They're *peer* subsystems and the Memory OS
above (e.g. MSP) orchestrates them. See
[ADR-009](./docs/adr/009-msp-as-orchestrator.md) for the rationale and
[`docs/MSP_RELATIONSHIP.md`](./docs/MSP_RELATIONSHIP.md#coexisting-with-peer-subsystems-eg-gitnexus)
for the worked example. Caching GitNexus call-edges into GKS's
`GraphBackend` for fast reads is allowed (denormalisation owned by MSP,
not a runtime dependency).

## Backends

Mix and match:

| Vector | Graph | Reranker | Obsidian |
|---|---|---|---|
| JSONL (default) | in-memory `GraphStore` (default) | BM25 lexical (default) | (none) |
| `PgvectorBackend` | `PgGraphBackend` | HTTP cross-encoder (BGE rerank-v2 via TEI) | `RestObsidianAdapter` |
| `HnswBackend` (in-process) | `KuzuGraphBackend` (planned) | custom `Reranker` | `MCPObsidianAdapter` (stdio) |

```ts
import {
  MemoryStore,
  createPgvectorBackend,
} from '@freshair129/gks'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = new MemoryStore({
  root: '.',
  vectorBackend: (name, embedder) => createPgvectorBackend({ pool, name, embedder }),
})
```

## Benchmarks

Three runners against published datasets:

```sh
LOCOMO_DATASET=...     npm run bench:locomo     -- --backend=pgvector --provider=ollama
LONGMEMEVAL_DATASET=... npm run bench:longmemeval -- --rerank-endpoint=...
                       npm run bench:beam        -- --backend=hnsw

# Sweep across the entire matrix:
npm run bench:sweep -- --config=benchmarks/sweep.example.json
```

Each runner outputs JSON + Markdown reports stamped with the git SHA and
embedder model versions. See
[`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) for the SOTA-claim path.

## Observability

```ts
import { setupTelemetry } from '@freshair129/gks'

const otel = await setupTelemetry({ serviceName: 'my-agent' })
// ...your agent runs...
await otel.shutdown()
```

Spans on retain/recall, histograms for embedder/rerank/recall latency,
counters for cache hits and retain volume — all OTLP-exportable. Full
inventory in [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md).

## Documentation

- [`SCOPE.md`](./SCOPE.md) — **what GKS is and isn't** (read first if proposing features)
- [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) — **adopting GKS in an existing project** (incremental, 7 phases)
- [`docs/WORKFLOW.md`](./docs/WORKFLOW.md) — **daily doc-to-code loop** (P1→P6 + hotfix + Agent Rule, with every CLI command at the right step)
- [`docs/TECHNICAL-OVERVIEW.md`](./docs/TECHNICAL-OVERVIEW.md) — **standalone technical reference** (architecture, API, layers, backends, MCP, CLI, all cross-cutting concerns)
- [`docs/MSP_RELATIONSHIP.md`](./docs/MSP_RELATIONSHIP.md) — why GKS is paired with MSP-shaped Memory OS layers + the contract between them
- [`docs/KNOWLEDGE-TYPES.md`](./docs/KNOWLEDGE-TYPES.md) — canonical reference for all 30+ atomic prefixes (ADR / FEAT / SKILL / GUARDRAIL / FR / NFR / INC / ISSUE / …)
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — layer model + sequence diagrams
- [`docs/ULTRAPLAN.md`](./docs/ULTRAPLAN.md) — multi-phase roadmap
- [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) — running real-scale evals
- [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) — OTel setup + dashboards
- [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md) — schema versioning policy
- [`docs/adr/`](./docs/adr/) — architecture decision records (15 entries)
- [`gks/`](./gks/) — **the repo's own atomic knowledge tree** (eat-your-own-dog-food). 9 atoms covering the four-layer architecture, the reverse-citation lookup decision, the issue tracker, the flat-layout decision, the extended taxonomy, the doc-to-code enforcement model, and the task-tracking boundary (ADR-015). Try it:
  ```sh
  npx tsx bin/gks.ts lookup ADR--REVERSE-CITATION-LOOKUP --root=.
  npx tsx bin/gks.ts lookup-by-symbol src/memory/index.ts:lookupBySymbol --root=. --json
  npx tsx bin/gks.ts verify-flow ADR--DOC-TO-CODE-ENFORCEMENT --root=.
  npx tsx bin/gks.ts validate --links --root=.
  ```

### Reference architectures

- [`examples/memory-os-architecture/`](./examples/memory-os-architecture/) —
  Python proof-of-concept layering a paradigm-agnostic **Memory OS** on top
  of GKS. Shows how to separate session/cascade/sandbox logic (kernel)
  from EVA-specific affect/RI behaviour (plugin) from storage (file or
  GKS-MCP). Useful if you're building an MSP-style "kernel" that uses
  GKS as its backend.
- [`examples/gitnexus-graph-cache/`](./examples/gitnexus-graph-cache/) —
  the **GitNexus → `GraphStore` denormalisation pattern** that
  [ADR-009](./docs/adr/009-msp-as-orchestrator.md) authorises. A small
  TS adapter periodically lands an AST export into a GKS graph file so
  reads serve from GKS without a GitNexus round-trip. Includes
  bi-temporal "what did the call graph look like on date X?" via
  `addEdge({ supersede: true })`.
- [`examples/drift-detection/`](./examples/drift-detection/) — the
  **bidirectional doc/code drift detector** that combines
  `lookupBySymbol` (atoms citing a path) with the cached call graph
  (downstream callers) into a single risk-classified report. Designed
  for a pre-push hook; aborts when an ADR or BLUEPRINT cites the
  changed code so the developer reviews the governing decision first.

## Development

```sh
npm install
npm run typecheck
npm test                    # 237 tests in CI
npm run quickstart           # end-to-end demo
```

## License

MIT — see [`LICENSE`](./LICENSE).
