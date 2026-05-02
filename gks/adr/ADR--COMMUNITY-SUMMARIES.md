---
id: ADR--COMMUNITY-SUMMARIES
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Higher-order summaries over atom communities
crosslinks: {"parent_concept":["CONCEPT--COMMUNITY-SUMMARIES"],"references":["ADR--SUMMARY-TLDR","ADR--FLAT-ATOM-LAYOUT","ADR--EXTENDED-TAXONOMY"]}
created_at: 2026-05-01T12:26:04.907Z
---

# ADR — Higher-order summaries over atom communities

## Context

Per [[CONCEPT--COMMUNITY-SUMMARIES]], synthesis questions ("summarise the
whole BLUEPRINT chain", "what does the local-first profile add up to?")
require reading several related atoms together. We need a primitive
that takes a seed atom plus a graph budget and returns one coherent
narrative.

The questions for this ADR are: **how is the community defined**, **how
is it cached**, and **what's the API shape**.

## Decision

Add **on-demand community summarisation** as a new MemoryStore method.
No new atom type, no new persistence layer — it's a pure read-side
primitive that composes the existing pieces (atomic index + crosslinks
+ TldrGenerator + LlmClient).

```ts
interface CommunityRequest {
  seed: string | string[]      // one or more atomic ids
  hops?: number                  // default 1; cap at 3
  edges?: ('references' | 'implements' | 'parent_concept' |
           'parent_adr' | 'parent_blueprint' | 'resolves')[]
                                 // default: all structural edges
  includeBodies?: boolean        // default false (use summary_tldr)
  maxMembers?: number            // hard cap, default 30
  generator?: TldrGenerator      // reused; "summarises a community"
                                 // is just summarisation with bigger
                                 // input
}

interface CommunityResult {
  members: string[]              // atomic ids actually included
  truncated: boolean             // true if maxMembers cap was hit
  summary: string                // ≤500-token narrative
  cached: boolean                // came from in-memory LRU cache
  inputTokensEstimate: number
}

class MemoryStore {
  summarizeCommunity(req: CommunityRequest): Promise<CommunityResult>
}
```

The community is defined as the **transitive closure** over the
specified `crosslinks` edges from `seed`, BFS-bounded by `hops`. Members
are sorted by phase ascending (concept → adr → blueprint → feat →
audit) so the synthesis prompt sees the dependency order naturally.

**Caching**: in-memory LRU keyed by
`(sorted_member_ids, generator.name, includeBodies)`. Cache lives on
the MemoryStore instance — no on-disk persistence in this ADR.
Persisted community summaries can be a follow-up if read amplification
warrants it.

**Token budget**: input prompt is `members.length × 200 tokens` for
the TLDR path, or `members.length × ~1000 tokens` for the full-body
path. With `maxMembers=30` and the default TLDR path the prompt fits
in a 7B local SLM's 8K window comfortably.

## Consequences

**Positive:**
- One synthesis call answers questions that previously required N
  body reads. Composes naturally with the local-SLM consolidator and
  TLDR machinery shipped earlier in this branch.
- Auditable by construction: `members[]` is the exact source set the
  caller can re-read with `lookup(id)` to verify any claim.
- No persistence layer means no schema migration, no staleness gate.
  The walk is deterministic; the synthesis is regenerated each call
  (with cache).

**Negative:**
- A synthesis is only as good as its sources. Atoms with no
  `summary_tldr` get included by body (longer prompt) or skipped (when
  `includeBodies: false`); we choose the former so partial coverage
  doesn't silently hide content.
- The hop walk uses *structural* crosslinks only (no semantic
  similarity). Loosely-tagged atoms won't be picked up. This is
  intentional — semantic neighbourhoods belong to the vector layer
  via a different recall mode, not to this primitive.

**Schema impact:** none. New API method only.

## Alternatives considered

1. **Pre-compute community summaries at promote time, persist to a
   `summary_community` field.** — *rejected.* Communities are caller-
   defined (different `hops` / `edges` produce different sets). Pre-
   computing one canonical community per atom would either be wrong
   for most callers or explode into combinatorics. On-demand + LRU
   cache is the right shape.

2. **Reuse the vector layer for community membership (semantic
   nearest-N).** — *rejected* for this ADR. Vector neighbourhoods are
   useful but they're a *different* primitive — answer to a different
   question (what's *similar*) rather than what's *related*. A
   future ADR can layer a `'semantic'` mode on top.

3. **New atom type COMMUNITY-- with persisted summaries.** —
   *rejected.* Same reason as (1): callers parameterise the
   community. Persisting one canonical version per parameter set
   creates a maintenance burden disproportionate to the read benefit
   (cache hit rates on synthesis questions tend to be low — agents
   ask different things).

4. **Delegate to GraphRAG library wholesale.** — *rejected.* The
   primitive we need is small (∼200 LOC) and the integration cost of
   a third-party graph store + library is large. Inline implementation
   keeps GKS dependency-light per [[ADR--FLAT-ATOM-LAYOUT]] philosophy.
