---
id: CONCEPT--SEMANTIC-COMMUNITY
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Semantic neighbourhood mode for summarizeCommunity
crosslinks: {"references":["CONCEPT--MEMORY-STORE"]}
created_at: 2026-05-02T06:15:07.458Z
---

# CONCEPT — Semantic neighbourhood mode for summarizeCommunity

## Problem

`summarizeCommunity` (shipped in BLUEPRINT--COMMUNITY-SUMMARIES) walks
**structural** crosslinks — `references`, `parent_concept`, `implements`,
etc. — to assemble a community around a seed atom. That works when the
authors of the atom tree have stamped explicit links between related
ideas.

It fails when:
- Two atoms talk about the same thing but no one wrote the crosslink
  (different authors, different times, missed convention).
- A new atom landed without backfilling references to prior art.
- Imported content (e.g., from MSP / EVA / external knowledge bases)
  doesn't have GKS-shaped crosslinks at all.

ADR--COMMUNITY-SUMMARIES alternative #2 explicitly deferred a
"semantic mode" — vector-similarity-based community membership — for
a follow-up. This concept opens that follow-up.

## Hypothesis

If `summarizeCommunity` accepts an additional **semantic membership
mode** that:

1. Embeds the seed atom's content (or `summary_tldr` if present),
2. Searches the vector layer for top-K nearest atoms by cosine,
3. Filters by score threshold (default 0.75),
4. Merges results with structural-walk members (deduplicating),

then community membership becomes resilient to missing crosslinks.
Authors can express loose semantic relationships without hand-stamping
every edge.

The cost:
- One extra embedding call per seed (~50 tokens via local nomic).
- One vector search call per seed.
- Threshold tuning becomes a knob — too low introduces noise, too
  high misses things.
- Membership is no longer purely deterministic (depends on embedding
  state).

The trade is favourable for **discovery-style** queries
("summarise everything related to local-first profile") where a
human couldn't reasonably be expected to maintain a complete
crosslink graph by hand. Structural-only mode stays the default for
**audit-style** queries where deterministic membership matters.
