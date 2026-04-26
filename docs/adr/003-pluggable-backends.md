# ADR 003 — Pluggable backend interfaces

- **Status:** accepted
- **Date:** 2026-04-24
- **Deciders:** core
- **Context tag:** architecture, extensibility

## Context

Phase 1 ships file-based defaults (ADR 001). To avoid painting
ourselves into a corner, every external dependency boundary needs an
interface so production-class adapters can drop in without a re-write.

## Decision

Define minimal interfaces for each replaceable concern. Concrete defaults
live alongside; production adapters land in Phase 2B.

| Capability | Interface | Default | Production |
|---|---|---|---|
| Vector store | `VectorBackend` | JSONL `VectorStore` | `PgvectorBackend`, `HnswBackend` |
| Graph store | `GraphBackend` | in-mem `GraphStore` | `PgGraphBackend` |
| Reranker | `Reranker` | BM25 lexical | `httpReranker` |
| LLM client | `LlmClient` | heuristic in Consolidator | `createAnthropicClient` |
| Obsidian | `ObsidianAdapter` | `MockObsidianAdapter` | REST + MCP-stdio |
| Embedder | `Embedder` | mock SHA-256 | Ollama / OpenAI |

Each interface keeps its surface SMALL. `VectorBackend` is currently
~12 methods; only `add`, `addWithVector`, `search`, `patchMetadata{,Many}`,
`get`, `clear`, `listDocs`, `setFileHash` (optional), `rewriteAll`
(optional), plus the embedder + name fields.

## Consequences

**Positive**
- pgvector + HNSW + PgGraphBackend landed in Phase 2B with zero
  changes to retain/recall/reflect callers.
- Tests use a 50-line in-memory backend (`test/memory/vector-backend.test.ts`)
  to verify the interface contract without disk I/O.
- Phase 2B's choice to cut FalkorDB (ADR 005) was painless because
  GraphBackend was already abstracted.

**Negative**
- Slight verbosity at MemoryStore ctor — every option is a possible
  factory (vectorBackend, obsidian, etc.).
- Some adapters need optional methods (`rewriteAll`, `setFileHash`)
  that Postgres-style backends might not implement; callers guard
  with `if (vStore.setFileHash)`.

## Implementation note: factories vs instances

`MemoryStoreOptions.vectorBackend` is a *factory* `(name, embedder) =>
VectorBackend`, not an instance. Factories let us produce one backend
per (atomic / episodic / ...) store name lazily, sharing a single
`pg.Pool` / `hnswlib` library between them. This pattern repeats for
the graph backend and obsidian adapter.

## References

- `src/memory/vector/backend.ts` — `VectorBackend`
- `src/memory/graph.ts` — `GraphBackend`
- `src/memory/obsidian-mcp.ts` — `ObsidianAdapter`
