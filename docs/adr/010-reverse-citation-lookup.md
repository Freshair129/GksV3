# ADR 010 — Bidirectional traceability via reverse citation lookup

- **Status:** accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Context tag:** traceability, drift-detection, doc-to-code, scope

## Context

The doc-to-code workflow (MSP §6) is one-directional by design: spec
flows down (`P2 atom → P3 blueprint → P3.5 microtask → P5 code → AST`),
and **propagation is not automatic** — each transition is a deliberate
human-or-agent action gated by validation.

ADR-009 split graph responsibilities horizontally:
- **GKS** owns *atom-level* relationships (note ↔ note backlinks).
- **GitNexus** owns *code-level* relationships (function ↔ function,
  file ↔ file, AST).

`linked_symbols` (added in 3.5.1) and `geography` (P3 blueprint field)
let atoms cite specific code symbols. This is **forward** traceability
— given an atom, find the code it governs.

The gap: **no reverse traceability**. When a developer edits
`src/stock/fefo.ts:applyFefo`:
- GitNexus tells them which *code* is affected (callers, importers).
- Nothing tells them which *atoms* govern that code.

The result is the exact failure mode `BLUEPRINT--memory §write_rules`
forbids: code drifts ahead of doc, the SSOT becomes a lie, and the
audit trail (P6) can no longer verify "code matches blueprint."

## Decision

Add a **reverse citation lookup** to GKS:

```ts
MemoryStore.lookupBySymbol(symbolPath: string): Promise<AtomicHit[]>
```

The query returns every atom whose `linked_symbols` (or, for
blueprints, `geography`) entry matches `symbolPath`. Match semantics:

| Atom citation                        | Query                              | Match? |
|--------------------------------------|------------------------------------|:--:|
| `{ file: "src/x.ts", fn: "foo" }`    | `src/x.ts:foo`                     | ✓ |
| `{ file: "src/x.ts", fn: "foo" }`    | `src/x.ts`                         | ✓ (file-level) |
| `{ file: "src/x.ts" }` (file only)   | `src/x.ts:foo`                     | ✓ (atom is broader) |
| `{ file: "src/x.ts", fn: "foo" }`    | `src/x.ts:bar`                     | ✗ |
| `{ file: "src/x.ts", fn: "foo", line: 42 }` | `src/x.ts:foo:42`           | ✓ |

Surfaces:
- **TS API:** `MemoryStore.lookupBySymbol(path)`
- **CLI:** `gks lookup-by-symbol src/x.ts:foo`
- **MCP:** new tool `gks_lookup_by_symbol`
- **Audit log:** logged as `op: 'lookup_by_symbol'` with the query and
  hit count (no symbol value bleed — same redaction story as `lookup`)

The atomic_index loader (`AtomicLayer.loadIndex`) is extended to
preserve `linked_symbols` and `geography` fields when present in a row,
so the in-memory index can answer reverse queries without touching the
filesystem on the hot path.

## Consequences

**Positive**

- **Closes the bidirectional drift loop.** Combined with GitNexus's
  AST-level `detect_changes`, an MSP pre-commit hook can now catch:
  "this code has citations from N atoms; review them or mark as
  still-current."
- **Fits inside ADR-008 scope.** This is a query primitive over data
  GKS already stores — not a workflow feature, not a code analyzer.
  GKS's job is to make stored citations queryable in both directions.
- **Fits ADR-009 boundaries.** GitNexus is unaware of this. The
  orchestrator (MSP) still owns the workflow that consumes both
  systems' answers; this ADR just adds the missing primitive.
- **Auditable.** Audit log captures every reverse-lookup, so post-hoc
  drift investigations have provenance.

**Negative**

- **Linear scan on every call.** O(N) over the index, where N is the
  number of indexed atoms. Acceptable while atoms stay in the
  hundreds-to-low-thousands; if a deployment scales past that, a
  per-symbol-path inverted index becomes worthwhile (deferred — add
  when measured).
- **Atomic-index format change.** Existing JSONL rows without
  `linked_symbols` / `geography` keep working (fields are optional).
  Re-running the indexer on existing data will refresh the rows that
  carry citations.
- **Citation drift.** A `linked_symbols` entry pointing at a
  symbol that no longer exists is *itself* a drift signal. GKS does
  not auto-validate against the codebase (per ADR-008/009 — no AST
  inside GKS); the orchestrator combines `lookupBySymbol` with
  GitNexus's `query` to detect dead citations.

## Alternatives considered

1. **Maintain the inverse index in MSP/orchestrator.** Walk all atoms,
   build a `Map<symbolPath, AtomId[]>` in memory, refresh on change.
   *Rejected:* GKS already has the data and the index abstraction;
   pushing the inverse out wastes the work and forces every MSP
   variant to reimplement it.

2. **Push reverse lookup into GitNexus** (let GitNexus index atom
   citations alongside code edges). *Rejected:* breaks ADR-009 ("no
   edge between GKS and GitNexus"); makes GitNexus depend on GKS data
   layout.

3. **Defer until pre-commit demands it.** *Rejected:* the user-facing
   problem (doc/code drift after a code edit) is real today; the
   primitive is small (~80 LOC + tests); adding it now closes the
   architecture, not later.

4. **Inverted index file** (`citations_by_symbol.jsonl`) maintained
   alongside `atomic_index.jsonl`. *Deferred.* Useful at scale but
   the linear scan over a few hundred atoms is sub-millisecond — no
   reason to add a second persistence file yet.

## References

- ADR 008 — GKS as storage engine (this is a query primitive, not
  workflow → in-scope)
- ADR 009 — MSP orchestrates peer subsystems (orchestrator combines
  this lookup with GitNexus's `detect_changes`)
- 3.5.1 release — `linked_symbols` field added to atoms (the data
  this ADR makes queryable in reverse)
- `src/memory/gks.ts` — `AtomicLayer.searchBySymbol` implementation
- `src/memory/index.ts` — `MemoryStore.lookupBySymbol` exposure
- `bin/gks.ts` — CLI subcommand
- `src/mcp-server/index.ts` — `gks_lookup_by_symbol` MCP tool
