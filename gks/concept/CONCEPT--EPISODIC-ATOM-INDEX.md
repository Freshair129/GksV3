---
id: CONCEPT--EPISODIC-ATOM-INDEX
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Persisted reverse atom→episode/turn index
crosslinks: {"references":["CONCEPT--MEMORY-STORE","CONCEPT--REVERSE-EPISODIC-LOOKUP"]}
created_at: 2026-05-02T13:40:45.954Z
---

# CONCEPT — Persisted reverse atom→episode/turn index

## Problem

`MemoryStore.lookupByAtom(atomId)` (BLUEPRINT--REVERSE-EPISODIC-LOOKUP)
walks every v2 session in the episodic store and filters by typed
crosslink predicates. ADR-REVERSE-EPISODIC-LOOKUP explicitly chose
**live scan** for the MVP and deferred a persisted index:

> Persisted reverse index... *Rejected* for the MVP — adds invalidation
> surface (delete an episode → must purge refs); not justified before
> measured demand.

That tradeoff is right at small scale. But:

- Each `lookupByAtom` call reads `_index.jsonl` (one line per session)
  + opens every session's `episodes.jsonl` + `turns.jsonl`.
- Cost is O(sessions × turns_per_session).
- For a multi-tenant store with hundreds of sessions and tens of
  thousands of turns, every reverse-lookup query scans the whole
  store.

In long-running orchestrator workloads (MSP, batch agents) the same
atom ids get queried repeatedly across sessions. The repeated linear
scans become the bottleneck.

## Hypothesis

If GKS maintains a persisted **inverted index** at
`<episodicDir>/_atom_refs.jsonl` keyed by `atom_id`, with one line
per (atom_id, session_id, episode_id?, turn_id?, predicate) tuple,
then:

1. `lookupByAtom` becomes a single-grep over the index file (fast)
   instead of an O(N) walk of all sessions.
2. The index is **derived data** — recomputable from the source of
   truth (per-session jsonl files). Invalidation is recovery, not a
   correctness concern: stale entries just produce extra refs that
   the caller can re-verify.
3. Index updates are append-only at `appendEpisode` /
   `appendTurn` time — same write profile as the rest of the v2
   layer.
4. A `gks episodic reindex` CLI rebuilds the index from scratch
   when needed (recovery + cold-start scenarios).

The cost: every `appendTurn` that has crosslinks does one extra
appendJsonl. Negligible vs the LLM call that produced the turn.

This converts the lookup primitive from O(all-sessions) to
O(matching-refs) — same algorithmic class as
`lookupBySymbol(file:fn)` over `atomic_index.jsonl`.
