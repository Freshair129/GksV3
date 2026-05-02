---
id: CONCEPT--SEMANTIC-FRAMES
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Per-turn semantic_frames inference
crosslinks: {"references":["CONCEPT--EPISODIC-V2"]}
created_at: 2026-05-02T13:34:39.028Z
---

# CONCEPT — Per-turn semantic_frames inference

## Problem

The v2 episodic Turn carries a `semantic_frames?: string[]` field
(BLUEPRINT--EPISODIC-V2) — a short list of FrameNet-style or
domain-specific frames the turn evokes (e.g. `["question",
"constraint"]`, `["proposal", "comparison"]`). Today the field is
**always undefined** because nothing populates it:

- `appendTurn` accepts the field but doesn't infer it
- `endSession` writes turns straight from the trace with only
  `kind`, `t`, and `raw_text` set
- The schema exists but has no producer

This was deliberate at v2 ship time — the BLUEPRINT marked it as a
follow-up:
> "Per-Episode `semantic_frames` inference (consolidator's job)"

But without a producer, the field is dead weight on disk. Recall
queries can't filter by frame; the consolidator has no signal beyond
raw text; the lookup primitive can't narrow on "all turns where the
user constrained the agent's options".

## Hypothesis

If GKS exposes a `createSemanticFramesInferrer(opts)` factory + an
`endSession` option to invoke it after writing turns, then:

1. Each turn gets a 1–4 frame array stamped onto its `turns.jsonl`
   row at end-of-session.
2. The inferrer runs **once** for the whole session (one LLM call,
   like the boundary detector) — model sees all turns and
   produces an array-of-arrays response.
3. Heuristic fallback (no LLM) returns sensible defaults from the
   turn's `kind` field (e.g., `kind: 'user'` + question mark →
   `["question"]`; `kind: 'tool'` → `["action"]`).
4. Default behaviour (no opts) is byte-identical to today — no
   regression for callers that don't opt in.

The cost: one LLM call per endSession when wired in. Same
amortisation profile as the LLM boundary detector.

This closes the only schema field in EPISODIC-V2 that has no
producer, and gives the recall + reverse-lookup paths a structured
signal beyond raw text.
