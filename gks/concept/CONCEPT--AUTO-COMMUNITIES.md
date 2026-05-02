---
id: CONCEPT--AUTO-COMMUNITIES
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Auto-detected communities via graph clustering
crosslinks: {"references":["CONCEPT--MEMORY-STORE"]}
created_at: 2026-05-02T06:34:22.286Z
---

# CONCEPT — Auto-detected communities via graph clustering

## Problem

`summarizeCommunity` (BLUEPRINT--COMMUNITY-SUMMARIES) requires the
caller to **know which seed atom to start from**. That works when the
agent has a question framed around a known atom — "summarise everything
near `FEAT--SUMMARY-TLDR`". It breaks down when the agent wants:

- **Overview**: "What's in this knowledge base, organised by topic?"
- **Discoverability**: "Show me coherent clusters I might want to ask
  about."
- **Maintenance**: "Which atoms are orphans? Which clusters are over-
  connected and should be split?"

Microsoft GraphRAG built its entire pipeline around **community
detection** for exactly this reason — graph-level structure surfaces
topics the user didn't already know to ask about.

## Hypothesis

If GKS exposes a `detectCommunities()` primitive that:

1. Builds an undirected graph from atom crosslinks (every typed-link
   target becomes an edge),
2. Runs a deterministic clustering pass — **Louvain-style modularity
   maximisation** — to partition the graph into communities,
3. Returns each community with `members[]`, `density` (intra-community
   edge ratio), and a stable `community_id`,

then the agent can:
- Iterate over communities and call `summarizeCommunity` on each →
  whole-knowledge-base overview.
- Surface orphan atoms (singleton communities) for review.
- Use `density` as a signal for cluster quality (low-density clusters
  may need refactoring).

The cost:
- One graph pass per call (cheap — atomic_index.jsonl is small).
- Louvain has known stochastic behaviour (depends on node iteration
  order); we'll seed deterministically for reproducibility.
- The detected communities are derived from current crosslinks — they
  reflect the *graph structure*, not necessarily the *true topical
  structure*. Pair with semantic mode (separate proposal) for
  topic-aware variants.

This is the natural "discovery" complement to the existing seed-driven
`summarizeCommunity` — same downstream synthesis pipeline, different
membership selection step.
