---
id: FEAT--AUTO-COMMUNITIES
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Auto-detected communities
crosslinks: {"parent_concept":["CONCEPT--AUTO-COMMUNITIES"],"parent_adr":["ADR--AUTO-COMMUNITIES"],"parent_blueprint":["BLUEPRINT--AUTO-COMMUNITIES"]}
linked_symbols:
  - {"file":"src/memory/community-detect.ts","fn":"detectCommunities"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.detectCommunities"}
created_at: 2026-05-02T06:34:26.888Z
---

# FEAT — Auto-detected communities

## User-facing behaviour

> Given a developer holding a `MemoryStore` instance,
> when they call `store.detectCommunities()`,
> then GKS returns every coherent cluster in the atom crosslink graph
> — each with `community_id`, `members[]`, `size`, and `density` —
> plus the list of orphan atoms and global modularity.

> Given the same call repeated on an unchanged atom index,
> when it runs again,
> then the result is byte-identical (deterministic node iteration,
> deterministic tie-breaking, smallest-member-id as cluster label).

> Given an agent that wants per-cluster summaries,
> when it calls `detectCommunities()` then loops over each cluster
> calling `store.summarizeCommunity({ seed: cluster.members, hops: 0 })`,
> then GKS produces one synthesised narrative per cluster.

## Acceptance criteria

- [ ] **AC1**: `src/memory/community-detect.ts` exports
      `detectCommunities()`, `buildAtomGraph()`, `louvainLite()`,
      and the related types per the BLUEPRINT shape.
- [ ] **AC2**: `MemoryStore.detectCommunities(opts?)` is defined,
      returns a `DetectCommunitiesResult`, exported from
      `src/memory/index.ts`.
- [ ] **AC3**: Output is deterministic across consecutive calls on
      an unchanged atom index (same communities, same community_ids,
      same member ordering).
- [ ] **AC4**: Singleton clusters (size 1) are reported as
      `orphans[]`, NOT in `communities[]` (when `minSize >= 2`,
      default).
- [ ] **AC5**: `density` is computed correctly: 3-clique = 1.0,
      3-path = 2/3, 2-isolated-node-pair = 0.0 (impossible, always
      density = 1 when n=2 with one edge).
- [ ] **AC6**: `edgeKeys` option restricts which crosslink predicates
      contribute edges. Excluded predicates produce different community
      structure (verified by test).
- [ ] **AC7**: Dangling crosslink targets (id not in index) are
      silently dropped — no error, no phantom community member.
- [ ] **AC8**: `modularity` field is within `[-0.5, 1.0]` and
      strictly positive for any non-trivial fixture.
- [ ] **AC9**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests in `test/memory/community-detect.test.ts`.

## Out of scope

- CLI subcommand (`gks community detect`) — small follow-up, separate
  PR.
- Multi-level Louvain (full coarsening). Greedy single-pass is
  sufficient for current scale.
- Persisted communities — would couple to atom write path; pair with
  PERSISTED-COMMUNITY-SUMMARIES if read amplification justifies.
- Semantic-similarity-based community membership (orthogonal to
  this proposal — see SEMANTIC-COMMUNITY).
- Community labelling / naming via LLM (callers can chain
  `summarizeCommunity` for that).
