---
id: FEAT--COMMUNITY-SUMMARIES
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Higher-order summaries over atom communities
crosslinks: {"parent_concept":["CONCEPT--COMMUNITY-SUMMARIES"],"parent_adr":["ADR--COMMUNITY-SUMMARIES"],"parent_blueprint":["BLUEPRINT--COMMUNITY-SUMMARIES"]}
linked_symbols:
  - {"file":"src/memory/community.ts"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.summarizeCommunity"}
created_at: 2026-05-01T12:26:07.855Z
---

# FEAT — Higher-order summaries over atom communities

## User-facing behaviour

> Given a developer holding a `MemoryStore` instance,
> when they call `store.summarizeCommunity({ seed: 'FEAT--SUMMARY-TLDR', hops: 2 })`,
> then GKS walks the structural crosslinks from that seed up to two
> hops, gathers the `summary_tldr` of each reachable atom, and returns
> a `CommunityResult` whose `summary` is a single coherent narrative
> over the chain (`FEAT → BLUEPRINT → ADR → CONCEPT`) plus a `members`
> list the caller can audit.

> Given the same call repeated with identical args,
> when nothing has changed in the index,
> then the second call returns `cached: true` without re-invoking the
> generator.

> Given a developer with no LLM client configured,
> when they call `summarizeCommunity()` and pass the default
> `heuristicTldrGenerator()`,
> then GKS returns a deterministic bullet-list summary built from the
> members' TLDRs — no API call, no crash.

## Acceptance criteria

- [ ] **AC1**: `src/memory/community.ts` exports `walkCommunity()` and
      `buildCommunityPrompt()` with the signatures from
      [[BLUEPRINT--COMMUNITY-SUMMARIES]].
- [ ] **AC2**: `MemoryStore.summarizeCommunity(req)` is defined,
      returns a `CommunityResult`, and is exported from
      `src/memory/index.ts`.
- [ ] **AC3**: BFS walk respects `hops` (1..3, capped at 3) and
      `edges` (defaults to all structural edges). Deeper-than-`hops`
      atoms are excluded.
- [ ] **AC4**: `maxMembers` cap is enforced (default 30). When hit,
      `truncated: true` in the result.
- [ ] **AC5**: Members are sorted by `phase` ascending then `id`
      ascending — deterministic across runs.
- [ ] **AC6**: When `includeBodies: false` (default) and an atom has
      `summary_tldr`, that's used in the prompt. When the field is
      absent, the body is used instead (so partial coverage doesn't
      silently lose content).
- [ ] **AC7**: LRU cache (max 64 entries) keyed by
      `(sorted_member_ids, generator.name, includeBodies)`. Cache
      hits set `cached: true`.
- [ ] **AC8**: With the heuristic generator, the synthesis is a
      bulleted markdown list of each member's TLDR first sentence
      (deterministic, no LLM call).
- [ ] **AC9**: With an LLM-backed generator, the prompt format is
      `Atom: <id> — <title>\n<tldr>\n\n` per member; the LLM's
      output text is returned verbatim (sanitised the same way as
      the per-atom TLDR generator).
- [ ] **AC10**: 7 verification scenarios from the BLUEPRINT
      (`V1` through `V7`) ship as automated tests in
      `test/memory/community.test.ts`. No existing test regresses.

## Out of scope

- Persisted community summaries (would create cache-invalidation
  surface; revisit if read amplification justifies it).
- Auto-detected communities (Louvain / clustering on the crosslink
  graph). Caller-defined seed + hops is the MVP shape.
- Semantic neighbourhoods (vector-similarity-based community membership).
  Different primitive; can layer on as a `'semantic'` mode later.
- Cross-namespace community walks. Stays within `defaultNamespace`.
