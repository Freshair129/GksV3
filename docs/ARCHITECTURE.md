# GKS v3 — Architecture

Companion to `BLUEPRINT--memory`.
Where the BLUEPRINT is the canonical spec, this page is the
"how-it's-actually-wired" overview for engineers picking up the codebase.

For incremental design decisions, see the ADR series in
[`docs/adr/`](./adr/).

---

## Layer dependency

```mermaid
graph TD
  CLI[bin/gks CLI] --> API
  MCP[gks-mcp-server] --> API
  API[api.ts<br/>retain · recall · reflect] --> Store
  Store[MemoryStore] --> Atomic[Atomic Layer<br/>gks.ts]
  Store --> Vector[Vector Layer<br/>VectorBackend]
  Store --> Episodic[Episodic Layer<br/>episodic.ts]
  Store --> Obsidian[Obsidian Adapter<br/>REST or MCP-stdio]
  Store --> Inbound[Inbound Queue<br/>inbound.ts]
  Store --> Audit[Audit Log<br/>audit.ts]
  Store --> Cost[Cost Tracker<br/>cost-tracker.ts]
  Store --> Reranker[Reranker<br/>BM25 / HTTP / custom]
  Vector --> Jsonl[VectorStore<br/>JSONL]
  Vector --> Pg[PgvectorBackend]
  Vector --> Hnsw[HnswBackend]
  Episodic --> EpisodicVec[Vector store<br/>episodic.jsonl]
  Atomic --> AtomicJsonl[atomic_index.jsonl]

  classDef store fill:#e0e7ff,stroke:#3730a3
  classDef adapter fill:#fef3c7,stroke:#92400e
  classDef cross fill:#dcfce7,stroke:#166534
  class Store store
  class Atomic,Vector,Episodic,Obsidian,Inbound adapter
  class Audit,Cost,Reranker cross
```

**Rule:** upper layers depend on lower; lower must NOT import from
upper. The orchestrator (apps using GKS) sits above CLI/MCP; the API
module knows nothing about CLI/MCP existence.

---

## Retain flow

```mermaid
sequenceDiagram
  autonumber
  participant Caller
  participant retain as api.retain()
  participant ns as Namespace<br/>resolution
  participant emb as Embedder
  participant rc as resolveConflicts()
  participant vs as VectorBackend
  participant cost as CostTracker
  participant audit as AuditLog

  Caller->>retain: { content, namespace?, conflictPolicy? }
  retain->>ns: merge defaultNamespace + input.namespace
  retain->>emb: embed(content) [ONCE]
  emb-->>retain: vector + token usage
  retain->>cost: record(usage, attrs)
  retain->>rc: search(vector, namespace-scoped)
  rc-->>retain: { conflicts, toInvalidate }
  retain->>vs: addWithVector(content, vector, metadata + namespace)
  alt toInvalidate.length > 0
    retain->>vs: patchMetadataMany([{id, valid_to, superseded_by}])
  end
  alt input.proposeInbound
    retain->>vs: proposeInbound (queue, not gks/)
  end
  retain->>audit: emit({op: retain, doc_id, namespace, conflicts})
  retain-->>Caller: { vectorDocId, conflicts, inboundPath? }
```

Single embed call per retain (the wrapping cost tracker reads it once).
Conflict detection runs against the same namespace; cross-tenant supersede
is impossible by construction.

---

## Recall flow

```mermaid
sequenceDiagram
  autonumber
  participant Caller
  participant recall as MemoryStore.retrieve()
  participant ns as Namespace<br/>resolution
  par parallel sources
    recall->>Atomic: searchById(query) if looksLikeAtomicId
    recall->>Vector: search(query, filter=namespace)
    recall->>Episodic: search(query, filter=namespace)
    recall->>Obsidian: search(query)
  end
  recall->>recall: merge + dedup (by path or id)
  recall->>recall: stable-status boost
  alt reranker enabled
    recall->>Reranker: score(query, top N candidate snippets)
    Reranker-->>recall: blended scores
  end
  recall->>recall: cap to maxTotal
  recall->>Audit: emit({op: recall, namespace, query, hit_count})
  recall-->>Caller: { hits, strategy, tookMs }
```

`crossNamespace: true` skips the namespace filter entirely — only meant
for admin / migration paths and emits a `meta.cross_namespace=true`
flag on the audit event so anomalies are easy to find.

---

## Bi-temporal lifecycle

```mermaid
stateDiagram-v2
  [*] --> Active: retain(v1)<br/>valid_from=t0, valid_to=null
  Active --> Superseded: retain(v2, supersede)<br/>v1.valid_to=t1, v1.superseded_by=v2
  Active --> Retracted: retractEdge(v1, t1)<br/>valid_to=t1
  Superseded --> [*]
  Retracted --> [*]
  Active --> Active: retain(v3, coexist)<br/>both valid

  note right of Active
    Default search filters out
    superseded + retracted unless
    asOf or includeInvalid is set.
  end note
```

The `asOf` query travels back in time:
`graph.query({ from:'u', rel:'LIVES_IN', asOf:'2023-06-01' })` returns
the edge that was current then, not now.

---

## Storage layout

```
<root>/
├── gks/                                  ← CANONICAL, READ-MOSTLY
│   ├── 00_index/
│   │   └── atomic_index.jsonl           ← AtomicLayer reads this
│   ├── concept/                         ← CONCEPT-- atoms
│   ├── frame/                           ← FRAME--
│   ├── adr/                             ← ADR--
│   ├── feat/                            ← FEAT--
│   ├── algo/                            ← ALGO-- · …
│   ├── blueprint/                       ← BLUEPRINT-- (yaml)
│   ├── issues/                          ← ISSUE-- (light-tier per ADR-012)
│   └── ...                              ← one folder per type (ADR-013)
└── .brain/msp/projects/evaAI/
    ├── memory/                          ← episodic markdown summaries
    │   └── MSP-SESS-...md
    ├── session/
    │   ├── MSP-SESS-...session.json     ← lifecycle + cost summary
    │   └── MSP-SESS-...trace.jsonl      ← append-only trace
    ├── inbound/                         ← queue of proposed atoms
    │   └── INSIGHT--FOO.rev-...md
    ├── vector/
    │   ├── atomic.jsonl                 ← (or *.hnsw, or pgvector schema)
    │   ├── episodic.jsonl
    │   └── _manifest.json               ← embedder + schema_version
    └── audit/
        └── audit-YYYY-MM-DD.jsonl       ← append-only audit log
```

**Write rules** (BLUEPRINT--memory § write_rules):

| Path | Write policy |
|---|---|
| `gks/` | NEVER write directly — go via `proposeInbound()` |
| `.brain/.../memory/*.md` | append-only; refuse-on-overwrite |
| `.brain/.../inbound/*` | each artifact is a new file with a unique reviewId |
| `.brain/.../vector/*.jsonl` | rebuildable; safe to overwrite via `re-embed` |
| `.brain/.../session/*.trace.jsonl` | append-only during the session |
| `.brain/.../audit/*.jsonl` | append-only forever |

---

## Pluggable boundaries

Every external dependency sits behind a small interface that has both an
in-process default and a production adapter:

| Capability | Interface | Default | Production |
|---|---|---|---|
| Vector store | `VectorBackend` | JSONL `VectorStore` | `PgvectorBackend`, `HnswBackend` |
| Graph store | `GraphBackend` | in-memory `GraphStore` | `PgGraphBackend` |
| Reranker | `Reranker` | BM25 lexical | `httpReranker` (TEI / BGE rerank-v2) |
| LLM client | `LlmClient` | (heuristic in Consolidator) | `createAnthropicClient` |
| Obsidian | `ObsidianAdapter` | `MockObsidianAdapter` | `RestObsidianAdapter`, `MCPObsidianAdapter` |
| Embedder | `Embedder` | mock SHA-256 | Ollama `bge-m3`, OpenAI fallback |

Adding a new backend = implement the interface + register a factory.
No callers change.

---

## Cross-cutting concerns

These wrap the core data path:

```mermaid
graph LR
  subgraph Cross-cutting
    Logger[Structured logger]
    Telemetry[OTel spans + metrics]
    Audit[Audit log<br/>per-op JSONL]
    Cost[CostTracker<br/>per-provider tally]
    Resilience[Retry + Circuit breaker<br/>on every network call]
  end

  Cross-cutting --> Embedder
  Cross-cutting --> Anthropic
  Cross-cutting --> Reranker
  Cross-cutting --> Vector
  Cross-cutting --> Recall
  Cross-cutting --> Retain
```

Each is opt-out via `MemoryStoreOptions`:
- `audit: false`           — disable audit log
- `cost: false`            — disable cost tracker
- `reranker: { enabled: false }` — disable reranker pass
- `obsidian: undefined`    — disable obsidian source
- Telemetry is no-op until `setupTelemetry()` registers an SDK
- Resilience is always on (the retry budget caps it; the breaker has
  reasonable defaults but is configurable per provider)

---

## Phase mapping

| Phase | Status | Lives in |
|---|---|---|
| 1 — Atomic + Vector + retain/recall + LoCoMo | ✅ | first commit + Slice A |
| 2A — Bi-temporal + reranker + LongMemEval + LLM consolidator | ✅ | Slice A |
| 2C — Re-embed + Obsidian REST + sessions | ✅ | Slice C |
| 2D — Graph + BEAM + VectorBackend abstraction + quickstart | ✅ | Slice D |
| 2B — pgvector + HNSW + PgGraphBackend + MCP-stdio + rerank fixtures | ✅ | Phase 2B |
| 3 — Backend-pluggable benchmarks + sweep runner | ✅ | Phase 3 |
| 4 — Observability + Resilience + Multi-tenancy + Cost + Schema migrations | ✅ | Phase 4 |
| 5 — MCP server + CLI + ADRs | ✅ (this slice) | Phase 5 |
| 6 — Release | pending | Phase 6 |

---

## Where to look

- Spec: `BLUEPRINT--memory` (root of repo, currently inline in commit history)
- Roadmap: [`docs/ULTRAPLAN.md`](./ULTRAPLAN.md)
- Benchmarks: [`docs/BENCHMARKS.md`](./BENCHMARKS.md)
- Observability: [`docs/OBSERVABILITY.md`](./OBSERVABILITY.md)
- Schema migrations: [`docs/MIGRATIONS.md`](./MIGRATIONS.md)
- ADRs: [`docs/adr/`](./adr/)
- Quickstart: [`examples/quickstart.ts`](../examples/quickstart.ts)
