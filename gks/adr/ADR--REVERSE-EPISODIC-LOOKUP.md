---
id: ADR--REVERSE-EPISODIC-LOOKUP
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Reverse episodic lookup
crosslinks: {"parent_concept":["CONCEPT--REVERSE-EPISODIC-LOOKUP"],"references":["ADR--REVERSE-CITATION-LOOKUP","ADR--EPISODIC-V2"]}
created_at: 2026-05-02T09:36:40.117Z
---

# ADR — Reverse episodic lookup

## Context

[[CONCEPT--REVERSE-EPISODIC-LOOKUP]] motivates a primitive that scans
v2 episodic stores (`session_id/{episodes,turns}.jsonl`) for entries
whose typed crosslinks reference a given atom id. Open questions:

1. **Live scan vs persisted reverse index?**
2. **What goes into the result shape?**
3. **How to filter by predicate type?**

## Decision

### 1. Live scan (MVP); persisted index = follow-up

Walk `<episodicDir>/_index.jsonl` to enumerate sessions, then for
each session open `episodes.jsonl` + `turns.jsonl` and filter by
target atom id. Same complexity as `lookupBySymbol` over the atomic
index (linear), but bounded by total turns across all sessions.

Rationale:
- Simplicity: no schema additions, no invalidation surface, no
  startup cost when the feature isn't used.
- The bottleneck for small/medium installations isn't scan time —
  it's making the question askable in the first place.
- A persisted inverted index can be added later as a cache tier
  (mirroring PERSISTED-COMMUNITY-SUMMARIES) once usage justifies it.

### 2. Result shape

```ts
interface EpisodeRef {
  session_id: string
  episode_id: string
  predicates: string[]   // which keys cited the target (e.g., 'discusses', 'implements')
  episode_type: Episode['episode_type']
  episode_tag?: string[]
}

interface TurnRef {
  session_id: string
  episode_id: string
  turn_id: string
  predicates: string[]
  speaker: string
  t: string              // turn timestamp for chronological ordering
}

interface LookupByAtomResult {
  atomId: string
  episodes: EpisodeRef[]   // sorted by session_id asc, episode_id asc
  turns: TurnRef[]         // sorted by t asc (chronological)
  scanned: { sessions: number; episodes: number; turns: number }
}
```

`predicates[]` lists every crosslink key under which the target
appeared, deduplicated. A turn that mentions FEAT--FOO under both
`discusses` and `implements` lands once with `predicates: ['discusses', 'implements']`.

### 3. Optional predicate filter

`opts.predicates?: string[]` restricts the scan to specific
crosslink keys. Default = all (matches every typed link to the
target). Useful for "find every episode that *implements* FEAT--FOO"
vs the broader "everywhere it was mentioned".

### 4. Public API

```ts
class MemoryStore {
  lookupByAtom(atomId: string, opts?: { predicates?: string[] }): Promise<LookupByAtomResult>
}
```

Plus a pure helper for direct test / orchestrator use:

```ts
function scanEpisodicForAtom(
  layer: EpisodicLayerV2,
  atomId: string,
  opts?: { predicates?: string[] },
): Promise<LookupByAtomResult>
```

Lives in `src/memory/episodic-v2.ts` (same module that wrote the
data — keeps the read primitive next to its store).

## Consequences

**Positive:**
- Symmetric to `lookupBySymbol` for the conversational layer.
- Zero schema impact; works retroactively on every existing v2 store.
- Composes with `summarizeCommunity`: caller can pass the matched
  episodes as a seed for further synthesis.

**Negative:**
- Live scan is O(sessions × turns). At small/medium scale this is
  fast; large installations should add a cache tier.
- Sessions without `_index.jsonl` rows are invisible (consistent
  with the rest of the v2 layer's contract).

**Schema impact:** none. Pure read primitive over existing storage.

## Alternatives considered

1. **Maintain a persisted inverse index** (`<episodicDir>/_atom_refs.jsonl`)
   updated on every `appendTurn` / `appendEpisode`. *Rejected* for the
   MVP — adds invalidation surface (delete an episode → must purge
   refs); not justified before measured demand.

2. **Stream-based API** (yield refs lazily). *Rejected.* Result sets
   are usually tens of items; an array fits the typical agent
   workflow without ergonomic loss.

3. **Embed the result in `MemoryStore.lookup(id)`** as an extra
   field. *Rejected.* `lookup(id)` returns the canonical atom note
   shape; bolting a possibly-large reference list onto it would
   force consumers to opt out for the common case.

4. **Use a separate CLI command per source** (`gks episodic lookup`,
   `gks atom lookup`, ...). *Rejected.* The single API is the
   ergonomic primitive; CLI surface is a thin wrapper.
