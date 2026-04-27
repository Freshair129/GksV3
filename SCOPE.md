# SCOPE — what GKS is and isn't

> **TL;DR:** GKS is a **Storage Engine** for agent memory.
> It is not a Memory OS, not a workflow framework, not a code intelligence
> layer. Other concerns belong elsewhere — this doc says where.

This file is the contract for contributors and downstream users. If a
proposed feature doesn't fit here, it doesn't go in `src/` — it goes in
its own package, repo, or layer above GKS.

---

## Layer position

```
┌────────────────────────────────────────────────────┐
│ Agent (any LLM)                                    │
└──────────────────────┬─────────────────────────────┘
                       │ retain / recall / reflect
                       ▼
┌────────────────────────────────────────────────────┐
│ Memory OS  (e.g. MSP-v9.1, your custom kernel)     │
│   policy / scheduling / consolidation / sandbox    │
│   ── NOT IN THIS REPO ──                           │
└──────────────────────┬─────────────────────────────┘
                       │ store / query / patch
                       ▼
┌────────────────────────────────────────────────────┐
│ GKS  (this repo)                                   │
│   atomic / vector / episodic / obsidian            │
│   audit / namespace / observability                │
│   MCP server + CLI surface                         │
└──────────────────────┬─────────────────────────────┘
                       │ raw I/O
                       ▼
┌────────────────────────────────────────────────────┐
│ Backends: HNSW / pgvector / JSONL / Obsidian REST  │
└────────────────────────────────────────────────────┘
```

GKS sits between **Memory OS** above and **storage backends** below.
It exposes primitives. It has no opinion about when to consolidate, what
counts as "important", or how an agent's session state should evolve —
those are Memory OS concerns.

---

## In scope

The features below are GKS's responsibility. Bug reports, perf work, and
new contributions targeting these are welcome.

### Storage layers
- **Atomic** — exact-id lookup against a JSONL index of canonical notes
- **Vector** — semantic search via pluggable backend (JSONL / HNSW / pgvector)
- **Episodic** — session traces (append-only JSONL) + summary markdown
- **Obsidian** — adapter for external knowledge bases via REST or MCP-stdio
- **Graph** — *atomic* relationship traversal (note ↔ note backlinks);
  see "Out of scope" for code-graph traversal

### Cross-cutting
- Bi-temporal versioning (`valid_from` / `valid_to` / `superseded_by`)
- Multi-tenant `Namespace = { tenant_id, user_id, session_id, agent_id }`
  with per-recall scoping + cross-namespace admin gate
- Append-only `AuditLog` (day-rotated JSONL) of every retain / recall /
  lookup / propose / write
- `CostTracker` — per-(provider, model) input/output tokens + USD tally
- OpenTelemetry façade (no-op default + `setupTelemetry` for OTLP)
- Retry (exp backoff + jitter) + circuit breaker primitives
- Schema migrations + version compatibility checks
- Rerank hook (cross-encoder blend, configurable α)
- LLM-driven consolidation hook (Three-Gate scoring is *deterministic*;
  the LLM only generates candidates)

### Surfaces
- **MCP server** (stdio) — `gks_retain`, `gks_recall`, `gks_lookup`,
  `gks_propose_inbound`, `gks_reflect`, plus admin `gks_recall_cross_namespace`
- **CLI** — `npx gks` for ad-hoc retain/recall/lookup/propose/reflect/init/status
- **TS API** — `MemoryStore` class + functional `retain`/`recall`/`reflect`

### Extension points (bring your own)
- `VectorBackend` — implement `addItem` / `search` / `patchMetadataMany`
- `GraphBackend` — implement `addEdge` / `neighbors` / `findPath`
- `Reranker` — implement `score(query, candidates)` for hybrid scoring
- `LlmClient` — implement `generate({ system, user, maxTokens })`
- `ObsidianAdapter` — implement `search` / `resolveWikilink` / `backlinksOf` / `tagQuery`
- `Embedder` — implement `embed` / `embedBatch` (via `EmbedderOptions`)
- `AuditLog.onEvent` hook — ship audit events to Splunk / Datadog / etc.
- `CostTracker` `attrs` — attach arbitrary labels (tenant_id, session_id) per record

---

## Out of scope

Everything below is intentionally not GKS's job. We won't accept PRs that
move these into `src/`. Pointers to where they belong follow each item.

### Memory OS responsibilities → live in your Memory OS layer
- **Consolidation timing** — when to fold sessions into cores, cores into
  spheres. GKS provides episodic write + reflect primitives; the *schedule*
  is policy.
- **Importance / RI level filtering at write time** — L1/L2/L3 / `Importance`
  enum. GKS stores everything you give it; the filter belongs upstream.
- **Sandbox / Origin-Buffer separation** — the read-only-during-session
  invariant. GKS is itself transactional but doesn't enforce session
  semantics.
- **Pre-consolidation backup + post-write verification cascade** — backup
  belongs to the Memory OS that owns the consolidation cascade.
- **Affect / emotion / RMS scoring** — completely out of scope.
- **Stakes-level / confidence-locking model** — EVA-specific epistemic
  workflow.

→ Standalone technical reference: [`docs/TECHNICAL-OVERVIEW.md`](./docs/TECHNICAL-OVERVIEW.md)
covers the full architecture, API, layers, backends, MCP / CLI surfaces,
and cross-cutting concerns — independent of any MSP-style framework.

→ Background: [`docs/MSP_RELATIONSHIP.md`](./docs/MSP_RELATIONSHIP.md)
records why GKS was designed to *receive* an MSP-shaped layer above
without implementing one itself.

→ Reference architecture: [`examples/memory-os-architecture/`](./examples/memory-os-architecture/)
shows a paradigm-agnostic Memory OS that uses GKS as its storage backend.

### Workflow / governance → live in process docs and CI
- **Phase-gate enforcement** (doc-before-code, ADR-required, blueprint-required)
  — these are CI lints + pre-commit hooks, not memory engine concerns.
- **Microtask codegen + composer** (Phase 3.5 SLM workflow) — separate tool.
- **Engineering laws** (file size limits, repository pattern checks) — eslint
  / linter rules, not GKS.
- **Multi-agent git strategy** — branch-naming + PR conventions, not memory.
- **ID naming conventions for process artifacts** (`MSP-IMP-`, `MSP-TSK-`,
  `MSP-WKT-`) — process discipline, lives in `registry.yaml` of the
  consuming project.

→ Reference: the `FRAMEWORK_MASTER_SPEC.md` from the EVA project documents
this layer; GKS does not implement it.

### Code intelligence → use GitNexus or similar
- **AST parsing** (TS / Python / Go / Rust / …) — language-specific work
  that grows quadratically with parser maintenance. Don't build it here.
- **Call graphs / import graphs / blast-radius analysis** — `GraphBackend`
  in GKS is for *atomic-note* edges (note ↔ note), not code edges.
- **Symbol resolution / refactoring assists / detect_changes** — out of
  scope.

→ Reference: pair `gks-mcp-server` with [`gitnexus mcp`](https://github.com/nxpatterns/gitnexus)
in your Claude Code MCP config — see `README.md` § "Pairing with a
code-structure layer".

### LLM-side concerns → caller's responsibility
- **Trust-boundary framing of recall snippets** — GKS marks `RetrievalHit.snippet`
  as untrusted in JSDoc + MCP tool descriptions. The actual prompt-side
  framing ("RETRIEVED CONTENT BEGIN/END" markers, etc.) is up to the agent
  builder.
- **Rate limiting LLM calls** — happens in your gateway / SDK.
- **Prompt construction for downstream agents** — out of scope.

---

## How to use GKS in different stacks

### Direct (no Memory OS) — simple agents
```ts
import { MemoryStore, retain, recall } from '@evaai/gks'

const store = new MemoryStore({ root: '.' })
await retain(store, { content: 'User prefers dark mode' })
const hits = await recall(store, 'preferences', { topK: 5 })
```

### Behind a Memory OS — sophisticated agents (EVA-style)
```python
# Memory OS (e.g. MSP-v9.1 or examples/memory-os-architecture/) owns
# policy + cascade; GKS is its storage backend.
from memory_os.eva import EvaMemoryOS
from memory_os.storage import GksStorage

os = EvaMemoryOS(
    storage=GksStorage(your_mcp_client),  # ← only line that mentions GKS
    rms_engine=RMSEngineV6(),
)
os.create_instance()
os.start_session()
os.write_episode_eva(episode, ri_level="L3", eva_affect_signal=...)
```

### Via MCP — any MCP-aware client (Claude Code, Cursor, custom)
```jsonc
// ~/.config/claude/mcp.json
{
  "mcpServers": {
    "gks": {
      "command": "npx",
      "args": ["gks-mcp-server", "--root=/path", "--tenant=alice"]
    }
  }
}
```

---

## Decision rule for proposed features

When proposing a feature, ask:

1. **Does it manipulate stored data, indexes, or queries?** → likely in scope
2. **Does it decide *when* something should happen (cascade, consolidation,
   eviction, retention)?** → Memory OS layer; out of scope
3. **Does it parse source code, build call graphs, analyze diffs?** → code
   intelligence layer (e.g. GitNexus); out of scope
4. **Does it enforce a process / workflow rule?** → CI / lint layer; out of scope
5. **Does it model affect, emotion, or domain-specific cognitive concepts?**
   → application layer; out of scope

If the answer to any of (2)–(5) is yes, the feature belongs in a layer above
GKS. PRs that conflate layers will be asked to split.

---

## What changes this scope?

- **Adding a new VectorBackend / GraphBackend / Reranker / LlmClient /
  ObsidianAdapter / Embedder** → no scope change; just plugs in
- **Adding a new MCP tool that wraps existing primitives** → no scope change
- **Adding a new persistence layer (e.g. SQLite-backed atomic index)** →
  in scope, ADR required
- **Adding a Memory-OS-shaped feature** (cascade, RI filter, stakes,
  affect) → out of scope; goes in a separate package that depends on GKS

Scope changes themselves require an ADR under `docs/adr/`.
