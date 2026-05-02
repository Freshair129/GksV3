---
id: CONCEPT--COMMUNITY-SUMMARIES
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Higher-order summaries over atom communities
crosslinks: {"references":["CONCEPT--MEMORY-STORE","CONCEPT--SUMMARY-TLDR"]}
created_at: 2026-05-01T12:26:03.333Z
---

# CONCEPT — Higher-order summaries over atom communities

## Problem

GKS today summarises **individual atoms** (per [[CONCEPT--SUMMARY-TLDR]]):
each atom carries a ≤200-token TL;DR generated once and returned as a
recall snippet. That works for *retrieval* — pick the right atom out of
many — but it doesn't answer *synthesis* questions like:

- "What does the doc-to-code enforcement chain say overall?"
- "Summarise everything I know about the local-first profile."
- "What are the key claims across the BLUEPRINT chain for SUMMARY-TLDR?"

Each of these requires reading **multiple related atoms together** and
producing one coherent narrative. With per-atom TLDRs we get N small
summaries; with the bodies we pay for N body reads. Neither scales.

This is the same gap Microsoft GraphRAG closes with *community
summaries* — pre-computed narratives at the level of a graph
neighbourhood — and Mem0 closes with workspace-level digests.

## Hypothesis

If GKS can produce a **community-level summary** on demand by:

1. Taking a seed atom (or seed set) plus a hop budget,
2. Walking the structured `crosslinks` to gather a coherent neighbourhood,
3. Concatenating each member's `summary_tldr` (cheap) into one prompt,
4. Asking an LLM (local SLM or cloud) to synthesise a single narrative,

then the agent can answer synthesis questions at the cost of *one* LLM
call regardless of community size, while preserving auditability
(every claim in the synth can be traced back to the cited atom ids).

The trade-off:

- **Cost:** one LLM call per synthesise-on-demand request. With per-atom
  TLDRs already populated, the input is roughly `community_size × 200`
  tokens — well within the context window of a 7B local SLM for
  communities up to ~30 atoms.
- **Determinism:** the *member set* is deterministic (graph walk); only
  the synthesis text varies between LLM runs. Good enough — recall
  doesn't depend on the synthesis text matching exactly.

This is the natural next layer above per-atom TLDRs: same machinery
(LlmClient, generator interface), one level up.
