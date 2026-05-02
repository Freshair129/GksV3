---
id: FEAT--SEMANTIC-COMMUNITY
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Semantic neighbourhood mode for summarizeCommunity
crosslinks: {"parent_concept":["CONCEPT--SEMANTIC-COMMUNITY"],"parent_adr":["ADR--SEMANTIC-COMMUNITY"],"parent_blueprint":["BLUEPRINT--SEMANTIC-COMMUNITY"]}
linked_symbols:
  - {"file":"src/memory/community.ts"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.summarizeCommunity"}
created_at: 2026-05-02T06:15:12.169Z
---

# FEAT — Semantic neighbourhood mode for summarizeCommunity

## User-facing behaviour

> Given an agent that wants community membership based on semantic
> similarity (not just structural crosslinks),
> when it calls `store.summarizeCommunity({ seed, mode: 'semantic',
> semanticThreshold: 0.8 })`,
> then GKS embeds the seed atom, vector-searches the atomic store
> for top-K nearest atoms above the threshold, and returns a
> `CommunityResult` whose `members` are the ids of those nearest atoms
> + a `membership_breakdown` showing the source path.

> Given an agent that wants both structural and semantic membership,
> when it calls with `mode: 'hybrid'`,
> then `members` is the deduplicated union of both walks, and
> `membership_breakdown.overlap` lists ids contributed by both paths.

> Given any caller that doesn't pass `mode`,
> when summarizeCommunity runs,
> then behaviour is byte-identical to the pre-change implementation
> (mode defaults to 'structural').

## Acceptance criteria

- [ ] **AC1**: `CommunityRequest` gains `mode`, `semanticThreshold`,
      `semanticTopK` fields per BLUEPRINT.
- [ ] **AC2**: `CommunityResult` gains `membership_breakdown` field
      (populated only when `mode !== 'structural'`).
- [ ] **AC3**: Default `mode = 'structural'` — no behavioural change
      for existing callers; existing community.test.ts cases pass
      unmodified.
- [ ] **AC4**: `mode = 'semantic'` skips structural walk entirely;
      result members come from `vectorSearch` only.
- [ ] **AC5**: `mode = 'hybrid'` returns the deduplicated union of
      both walks, sorted by phase asc / id asc.
- [ ] **AC6**: `mode = 'semantic'` or `'hybrid'` without
      `deps.vectorSearch` throws a clear, actionable error.
- [ ] **AC7**: LRU cache key includes mode/threshold/topK so identical
      seed/hops with different mode produces a fresh result.
- [ ] **AC8**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests with a stub `vectorSearch` (no real embedder
      calls).
- [ ] **AC9**: `MemoryStore.summarizeCommunity` plumbs a default
      `vectorSearch` from the existing atomic vector store + embedder
      so callers don't have to wire it manually.

## Out of scope

- New CLI flag (`gks community summarize --mode=semantic` is a small
  follow-up).
- Re-ranking semantic hits with a cross-encoder (would compose with
  existing rerank.ts but adds latency; defer until measured).
- Cross-namespace semantic walks.
- Persisted semantic-membership cache (the in-memory LRU is
  sufficient for now; PERSISTED-COMMUNITY-SUMMARIES is a separate
  proposal).
