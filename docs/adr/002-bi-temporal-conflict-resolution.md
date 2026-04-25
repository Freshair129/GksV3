# ADR 002 — Bi-temporal conflict resolution

- **Status:** accepted
- **Date:** 2026-04-24
- **Deciders:** core
- **Context tag:** semantics, retain

## Context

`Retain` needs a story for the case where new content semantically
overlaps with an existing doc. Three policies were on the table:

1. **Overwrite** — new doc replaces old; old is gone.
2. **Append** — every retain is additive; `recall` filters at query time.
3. **Bi-temporal supersede** — old gets a `valid_to` timestamp, new
   gets a `supersedes` pointer; both stay in the store; `recall` ignores
   superseded by default but `asOf` queries can travel back.

## Decision

Ship **bi-temporal supersede** (option 3) as the default behaviour, with
opt-out flags for append (`coexist`) and a strict overwrite mode
(implemented via supersede + manual filter — we never actually delete).

`RetainInput.conflictPolicy: 'auto' | 'supersede' | 'coexist'`. `auto`
supersedes when cosine ≥ threshold; `coexist` always keeps both.

## Consequences

**Positive**
- Audit trail by construction. Every "the user told the agent X is
  green" stays queryable for the day they later said it's blue.
- Enables `asOf(t)` semantics on the temporal graph (ADR 005-related).
- Supersede is namespace-scoped (ADR 004): tenant A's retain never
  touches tenant B's docs.

**Negative**
- Storage grows monotonically (mitigated by retention policies in
  Phase 6+; for now we accept the linear growth).
- The "what's currently valid" query needs a filter on every read.
  Backend predicates (Postgres partial index on `valid_to IS NULL`,
  `metadata.valid_to` filter on the JSONL backend) make this fast.

**Neutral**
- The default `auto` policy uses the same cosine threshold (0.92) for
  both detection and resolution. Configurable per call.

## References

- [BLUEPRINT--memory § write_rules](.../BLUEPRINT--memory.md)
- `src/memory/api.ts` — `resolveConflicts`
- `src/memory/graph.ts` — `addEdge({ supersede: true })`
