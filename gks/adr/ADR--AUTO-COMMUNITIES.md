---
id: ADR--AUTO-COMMUNITIES
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Auto-detected communities
crosslinks: {"parent_concept":["CONCEPT--AUTO-COMMUNITIES"],"references":["ADR--COMMUNITY-SUMMARIES","ADR--FLAT-ATOM-LAYOUT"]}
created_at: 2026-05-02T06:34:23.797Z
---

# ADR — Auto-detected communities

## Context

Per [[CONCEPT--AUTO-COMMUNITIES]], the agent needs an unsupervised
"give me clusters" primitive. Open questions:

1. **Which clustering algorithm?**
2. **What constitutes an edge?**
3. **How to keep results deterministic given Louvain's iteration-order
   sensitivity?**
4. **What goes into the result shape?**

## Decision

### 1. Algorithm: in-house Louvain-lite

Implement a small (~200 LOC) deterministic Louvain-style modularity
maximiser inline rather than pulling a dependency (`graphology`,
`graphology-communities-louvain`, ...). Reasons:

- Atom counts are bounded (currently 29 in this repo; production
  scales to thousands). Performance isn't the bottleneck.
- A dependency-free implementation matches GKS's "storage-engine
  with no large deps" philosophy ([[ADR--FLAT-ATOM-LAYOUT]]).
- The full Louvain spec adds complexity (multi-level coarsening) that
  isn't justified at this scale.

The "lite" variant runs a **single pass** of greedy modularity
moves: for each node in id-sorted order, move it to the neighbour
community that yields the largest modularity gain. Repeat until no
node moves. O(N × E) with low constants.

### 2. Edge construction

Undirected, one edge per (atom, target) pair across **all crosslink
predicates**, deduplicated. Multi-edges between the same pair count
once. Self-loops dropped. This matches the same set the existing
`walkCommunity` traverses, so members of a structural community
land in the same auto-detected cluster (within sensitivity to edge
density).

### 3. Determinism

Louvain order-of-iteration affects results. To get reproducible
clusters across runs:
- Iterate nodes in **lexicographically-sorted id order** (no random
  shuffle).
- Tie-breaking on equal modularity gain: prefer the lexicographically
  smallest target community id.
- Result `community_id` = the smallest member id (stable across runs
  for the same input graph).

### 4. Result shape

```ts
interface DetectedCommunity {
  community_id: string                 // smallest member id
  members: string[]                    // sorted by phase asc, id asc
  size: number
  /** Intra-community edges / max possible (n*(n-1)/2). 0..1. */
  density: number
}

interface DetectCommunitiesResult {
  communities: DetectedCommunity[]
  orphans: string[]                    // singleton communities
  total_atoms: number
  total_edges: number
  modularity: number                   // global Q value, -1..1
}
```

`detectCommunities(opts)` accepts `minSize` (skip clusters smaller
than this; orphans surface separately) and `edgeKeys` (restrict to
specific predicate types).

## Consequences

**Positive:**
- Discovery primitive complete — pairs naturally with
  `summarizeCommunity` (run detection → loop → summarise each).
- Orphan detection falls out as a side-effect.
- Density signal gives maintenance-style queries something to grip.
- Zero new dependencies.

**Negative:**
- Single-pass greedy Louvain is suboptimal vs full multi-level
  Louvain. Modularity scores will be ~5-10% lower than reference
  implementations on dense graphs. Acceptable for the use cases
  (overview, orphan detection); upgrade path exists if needed.
- Results depend on graph structure only — semantically-related
  atoms with no crosslinks don't cluster. (Pair with
  SEMANTIC-COMMUNITY mode for topic-aware variants.)
- `community_id = smallest member id` means renaming an atom
  changes its community_id. Acceptable; clusters are derived
  data, not identity.

**Schema impact:** none. Pure read-side primitive.

## Alternatives considered

1. **Connected components only.** — *rejected.* Too coarse — the
   whole atom tree often connects through `references` chains; you'd
   get one giant component plus orphans.

2. **Hierarchical clustering (agglomerative).** — *rejected.*
   Doesn't expose a natural "community" cutoff; user would have to
   pick a tree depth.

3. **Pull `graphology-communities-louvain` as a dep.** — *rejected.*
   Adds 50KB + transitive deps for ~200 LOC of inline logic at the
   scale GKS targets.

4. **Random-seeded Louvain (multiple runs, take best).** — *deferred.*
   Improves modularity score but breaks determinism. If callers
   want this, they can run detection multiple times with different
   permutations of input atoms; not in default API.

5. **Detect communities once at index time + persist.** — *rejected.*
   Tight coupling to atom write path. Communities depend on opts
   (minSize, edgeKeys), so a single canonical persisted set would
   be wrong for half the callers. On-demand stays cleaner; pair
   with PERSISTED-COMMUNITY-SUMMARIES if read amplification
   warrants caching.
