---
id: ADR--SEMANTIC-COMMUNITY
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Semantic neighbourhood mode for summarizeCommunity
crosslinks: {"parent_concept":["CONCEPT--SEMANTIC-COMMUNITY"],"references":["ADR--COMMUNITY-SUMMARIES"]}
created_at: 2026-05-02T06:15:09.026Z
---

# ADR — Semantic neighbourhood mode for summarizeCommunity

## Context

[[CONCEPT--SEMANTIC-COMMUNITY]] motivates allowing
`summarizeCommunity` to use **vector similarity** for community
membership in addition to (or instead of) structural crosslink walks.
The architectural questions:

1. How is membership computed?
2. How does it compose with the existing structural walk?
3. What's the API shape — new option on `CommunityRequest` or new method?

## Decision

Add a new field to `CommunityRequest`:

```ts
interface CommunityRequest {
  // ... existing ...
  /**
   * Membership composition mode:
   *   'structural' (default) — walk crosslinks only
   *   'semantic'             — vector nearest-neighbour only
   *   'hybrid'               — structural ∪ semantic, deduplicated
   */
  mode?: 'structural' | 'semantic' | 'hybrid'

  /** Cosine threshold for semantic membership (default 0.75). */
  semanticThreshold?: number

  /** Top-K passed to the vector search (default 10). */
  semanticTopK?: number
}
```

**Composition rules:**
- `structural` (default, unchanged): BFS-walk crosslinks. Same as today.
- `semantic`: skip the BFS, embed seed (using `summary_tldr` or body),
  vector-search top-K, filter by cosine ≥ threshold. `hops`/`edges`
  ignored.
- `hybrid`: union the two member sets, dedupe by `id`, sort by phase
  asc / id asc (same as before). Counts both contribution paths in
  the result for transparency.

**Vector access:** the function takes a new optional dependency in
`SummarizeCommunityDeps` — a `VectorBackend` for the atomic store.
Callers of the public `MemoryStore.summarizeCommunity` get this
plumbed for free; direct `summarizeCommunity()` callers (tests,
custom orchestrators) provide their own.

**Result shape change:** add `membership_breakdown` to `CommunityResult`:

```ts
interface CommunityResult {
  // ... existing ...
  membership_breakdown?: {
    structural: string[]
    semantic: string[]
    overlap: string[]      // ids in both sets
  }
}
```

Optional — populated only when `mode !== 'structural'`. Lets callers
audit which members came from which path.

**Backwards compatibility:** default `mode: 'structural'` keeps
existing behaviour byte-identical. No changes required for any
existing caller.

## Consequences

**Positive:**
- Discovery queries ("everything related to X") work without
  manually-stamped crosslinks.
- Composes with the local nomic embedder shipped earlier — semantic
  walks cost zero extra LLM tokens.
- Per-membership-source breakdown makes results auditable.
- Pluggable: `mode` is a knob, not a fork.

**Negative:**
- One extra embedding + one vector search per `summarizeCommunity`
  call in semantic/hybrid mode. Bounded by topK; worst case a few
  tens of ms with local nomic.
- Threshold is workload-dependent. Default (0.75) tuned for nomic-768;
  callers using OpenAI / different embedders should tune. Documented
  as a knob.
- Cache key must include `mode`/`threshold`/`topK` so structural and
  semantic results don't collide.

**Schema impact:** none on disk. New runtime fields only.

## Alternatives considered

1. **Separate method `summarizeSemanticCommunity`.** — *rejected.*
   Forces callers to pre-decide; hybrid mode would need a third
   method. A `mode` knob is simpler.

2. **Replace structural walk entirely with semantic.** — *rejected.*
   Audit-style queries (verify-flow, doc-to-code chain) need
   deterministic structural membership. Coexistence is the right shape.

3. **Use a separate vector index for community queries** (different
   embedder, different chunking). — *rejected.* Reuses the existing
   atomic vector store. Future tuning can layer a separate index if
   evidence supports it; not justified now.

4. **Embed all atoms eagerly + maintain an online clustering.** —
   *rejected.* Premature optimisation; on-demand vector search is
   fast enough and avoids cluster-staleness invalidation work.

5. **Make threshold absolute (cosine) vs relative (top-K rank).** —
   *both kept.* `semanticTopK` bounds compute cost; `semanticThreshold`
   filters quality. Either alone misses cases.
