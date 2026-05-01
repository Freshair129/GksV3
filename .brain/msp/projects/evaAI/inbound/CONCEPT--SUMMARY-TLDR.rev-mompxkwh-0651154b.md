---
proposed_id: CONCEPT--SUMMARY-TLDR
phase: 1
type: concept
status: raw
review_id: rev-mompxkwh-0651154b
proposed_at: 2026-05-01T09:36:39.186Z
crosslinks:
  references:
    - CONCEPT--MEMORY-STORE
    - ADR--NOMIC-EMBEDDER
    - ADR--FLAT-ATOM-LAYOUT
---

# CONCEPT — Pre-computed atom TL;DR summary field

## Problem

`recall()` returns either a 240-char body excerpt (default) or a title-only
snippet (with `snippetMaxChars: 0`, added in PR #25). Both choices have
costs:

- **240-char snippet** is too narrow to convey what an atom *means* —
  it's a cropped middle-of-the-document slice with no guarantee of
  containing the atom's thesis. Callers that want to make a decision
  ("should I open this?") often have to follow up with `lookup(id)`
  anyway, paying for the body load.
- **Title-only** is fast and cheap (~50 tokens/hit) but a title like
  *"Pre-computed atom TL;DR summary field"* doesn't tell a reader whether
  the atom actually answers their question. They still have to follow
  up with `lookup(id)`.

In both modes the bottleneck is the same: the atom doesn't carry a
**dense, calibrated summary** that recall can return cheaply. Every
caller pays the cost of reconstructing one — either by reading the body
(token-expensive) or by guessing from the title (accuracy-expensive).

This is the same trade-off Microsoft GraphRAG resolves with
*community summaries* and Mem0 resolves with *summary records*: pre-compute
once at write time, return many times at read time.

## Hypothesis

If every atom carries a `summary_tldr` field (≤200 tokens, generated once
when the atom is promoted or `retain()`-ed), then:

1. `recall()` can return `snippet = summary_tldr` instead of a body slice
   — same token budget as a 240-char snippet (~150-200 tokens) but
   actually informative.
2. The follow-up `lookup(id)` call rate drops materially (estimate: 50%+
   on benchmarks where the agent is making relevance decisions).
3. The summary can also feed downstream consumers: `verify-flow`'s
   chain-walk report, `validate-links` orphan detection, and the
   GraphRAG-style "summarize a community" pattern at higher orders.

The cost: one extra LLM call per atom at promote/retain time. With a
local SLM (per the existing local-only profile — Qwen2.5-7B / Phi-3.5),
this is ~2-5 seconds per atom and $0 marginal cost. With Sonnet 4.6,
it's ~$0.0005 per atom — negligible at any realistic atom count.

The trade is clearly favourable for read-heavy workloads (recall ≫
retain), which is the typical agent profile.
