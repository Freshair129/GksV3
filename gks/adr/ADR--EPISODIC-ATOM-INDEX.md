---
id: ADR--EPISODIC-ATOM-INDEX
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Persisted episodic atom index
crosslinks: {"parent_concept":["CONCEPT--EPISODIC-ATOM-INDEX"],"references":["ADR--REVERSE-EPISODIC-LOOKUP","ADR--FLAT-ATOM-LAYOUT"]}
created_at: 2026-05-02T13:40:47.590Z
---

# ADR — Persisted episodic atom index

## Context

[[CONCEPT--EPISODIC-ATOM-INDEX]] motivates a persisted inverted index
over typed crosslinks. Open questions:

1. **What's the index file format + location?**
2. **Where do writes happen?**
3. **How does invalidation / drift recovery work?**
4. **Is the index authoritative, or just a cache hint?**
5. **How does it compose with the namespace gate?**

## Decision

### 1. File: `<episodicDir>/_atom_refs.jsonl`

JSONL (matches the existing `_index.jsonl` convention next to it).
One line per ref:

```jsonc
{
  "atom_id": "FEAT--FOO",
  "session_id": "S-2026-...",
  "episode_id": "E-001",
  "turn_id": "T-0017",        // omit for episode-level refs
  "predicate": "discusses",
  "t": "2026-05-01T10:30:00Z" // turn timestamp; episode timestamp for episode refs
}
```

Multiple refs per turn (one per predicate × atom) — unique-by
sortable composite (`atom_id|session_id|episode_id|turn_id|predicate`).

### 2. Writes happen at `appendEpisode` / `appendTurn` + `patchTurnFrames`

Whenever crosslinks change on an Episode or Turn, the layer appends
one line per `(atom, predicate)` pair to `_atom_refs.jsonl`.
`appendTurn` is the high-volume path; the JSONL append cost is bounded
by `Object.keys(crosslinks).length` per turn — typically 1-3.

`patchTurnFrames` doesn't touch crosslinks, so no index update needed.

### 3. Invalidation: recovery, not correctness

The index is **strictly derived**. An entry pointing at a turn that
was rewritten (e.g., via `patchTurnFrames` losing crosslinks — though
we don't currently allow that) becomes stale but doesn't break
consumers — the lookup primitive can verify each ref against the
turns.jsonl row before returning, dropping stale entries silently.

**`gks episodic reindex`** CLI walks every session, rebuilds
`_atom_refs.jsonl` from scratch, and atomically renames it into
place. Use this after a manual edit, an `episodic migrate`, or for
periodic drift cleanup.

### 4. Index is a hint, not authoritative

The on-disk JSONL files (session.json + episodes.jsonl +
turns.jsonl) remain the source of truth for content. The atom-refs
index just narrows the scan. `lookupByAtom`:

- If `_atom_refs.jsonl` exists → grep it for matching atom_id, then
  re-verify each ref by opening the matching turn/episode line.
- Else (no index, e.g., legacy installs) → fall back to the
  existing live-scan implementation.

This means **first-time installs need no migration step** — the index
self-builds as new turns are written. `episodic reindex` covers
cold-start.

### 5. Namespace composition

The persisted index doesn't carry namespace itself — the existing
post-scan filter (BLUEPRINT--NAMESPACED-EPISODIC-LOOKUP) still runs
after grepping the index. Reasons:

- Index size stays small (atom_id + ids + predicate = ~120 bytes/row)
- Namespace is a session-level property; filtering by namespace
  needs reading session.json anyway

## Consequences

**Positive:**
- `lookupByAtom` becomes O(matching-refs) instead of O(all-turns).
- Same primitive shape as `lookupBySymbol` over `atomic_index.jsonl`.
- Self-building from new writes; no migration step required.
- `episodic reindex` CLI provides a recovery path.

**Negative:**
- Every appendTurn / appendEpisode with crosslinks does one extra
  JSONL append. Bounded by predicate count per crosslinks block;
  in practice <5 per turn.
- Cold-start performance for large stores: reindex walks every
  session. Mitigated by running it once at install time.
- Stale entries possible if files are manually edited outside GKS.
  Mitigated by the verify-on-read step + reindex CLI.

**Schema impact:**
- New file: `<episodicDir>/_atom_refs.jsonl`. Backwards-compat: when
  absent, falls back to live scan.
- No changes to existing on-disk files.

## Alternatives considered

1. **In-memory hash on EpisodicLayerV2.** *Rejected.* Lost across
   process restarts; defeats the read-amplification benefit for
   long-running orchestrators.
2. **SQLite / external DB.** *Rejected.* GKS philosophy is "files
   on disk, no large deps" ([[ADR--FLAT-ATOM-LAYOUT]]). JSONL grep
   is fast enough at the scale we target.
3. **Embed refs into `_index.jsonl`.** *Rejected.* Bloats the
   session-level index; refs grow with turn count, sessions don't.
4. **Update index lazily on first lookup.** *Rejected.* First
   lookup pays the full scan cost; defeats the point.
