# ADR 001 — File-based vector store as Phase 1 default

- **Status:** accepted
- **Date:** 2026-04-24
- **Deciders:** core
- **Context tag:** architecture, storage

## Context

`BLUEPRINT--memory` § layers.vector specifies a file-based vector store
as the Phase 1 default. We considered three options for the initial
implementation:

1. JSONL file (one VectorDoc per line) + cosine brute force in-memory
2. SQLite + a vector extension (e.g. `sqlite-vss`, `lance`)
3. Postgres + pgvector

## Decision

Ship **JSONL + brute-force cosine** as the default. Spend the
implementation budget on getting the surface (retain / recall / reflect,
namespace, audit, cost) right; defer hardware-class indexes (HNSW,
pgvector) to Phase 2B.

Pluggable `VectorBackend` interface (see ADR 003) means callers can
swap in pgvector or HNSW at config time.

## Consequences

**Positive**
- Zero dependencies for getting started; checkout + `npm install` is
  enough.
- One file per store keeps debugging trivial — `cat`, `jq`, `grep` all
  work.
- Brute-force cosine is correct at any scale (just slow); recall quality
  is identical to fancier indexes — no recall regressions when migrating.

**Negative**
- O(N·d) per query. Acceptable up to ~100k vectors at 1024 dimensions
  on a typical laptop (low single-digit ms).
- Memory pressure: the entire store is loaded into RAM on `load()`.
  Streaming variant deferred until we have a customer at >100k.

**Neutral**
- Forces us to design the `VectorBackend` interface early, which
  pays off when the pgvector / HNSW backends land.

## Alternatives considered

- **SQLite + vector extension.** Considered. Most options have
  immature ecosystems (sqlite-vss isn't bundled in `better-sqlite3`),
  and the install story is worse than "one .jsonl file".
- **Postgres from day one.** Considered. Reasonable for a
  team-installation but raises the bar for offline / single-developer
  use significantly. Punted to Phase 2B.

## References

- [BLUEPRINT--memory § layers.vector]
- [ADR 003 — Pluggable backend interfaces](./003-pluggable-backends.md)
