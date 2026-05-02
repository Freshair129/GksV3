---
id: CONCEPT--EPISODIC-V2
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Rich episode-level episodic memory schema
crosslinks: {"references":["CONCEPT--MEMORY-STORE","FRAME--FOUR-LAYERS","ADR--EXTENDED-TAXONOMY"]}
created_at: 2026-05-02T05:57:32.711Z
---

# CONCEPT — Rich episode-level episodic memory schema

## Problem

The current `EpisodicMemory` interface is one summary string per session
(`src/memory/types.ts:162`). That works for end-of-session rollups but
loses signal at the resolution agents actually need:

- **No episode boundary**: a 90-minute session with three context shifts
  ("debug an issue" → "discuss an architecture choice" → "casual chat")
  is one summary. Recall against any of those topics gets the same mush.
- **No per-turn cognitive state**: turns are stored in `trace.jsonl` as
  `{kind, content}` pairs. We don't know which turn was a question vs an
  explanation, which phrase carried the load, what action was taken.
- **No structured links from the session graph back to atoms**: only
  `linked_atoms[]` (flat array, untyped). There's no way to say "this
  episode `discusses` ADR--FOO and `contradicts` INSIGHT--BAR".
- **Mega-document write pattern**: the entire episodic record is
  rewritten on every endSession, blocking append-only / streaming
  consumers.

EVA's MSP-v9.1 already runs a richer schema (per-episode, per-turn,
typed) but it's coupled to EVA-specific concerns (ESS, RMS, EVA matrix,
emotional state). We want the structural backbone of that schema —
episode/turn split, cognitive metadata, typed crosslinks — without the
cognitive paradigm coupling.

## Hypothesis

If GKS stores episodic memory as **three append-only documents per
session** (`session.json` + `episodes.jsonl` + `turns.jsonl`) with
**typed crosslinks** matching the predicate convention used by atom
crosslinks today, then:

1. Recall can target episode-level granularity ("find episodes about
   bi-temporal resolution" rather than "find sessions").
2. Each turn carries `epistemic_mode`, `semantic_frames`,
   `salience_anchor`, `action` — enough metadata for downstream
   consolidators / orchestrators to reason without re-reading raw text.
3. The session graph plugs into `summarizeCommunity`,
   `verify-flow`, `lookupBySymbol` because crosslinks share the same
   shape as atom crosslinks.
4. Append-only writes mean a streaming agent can flush a turn at a
   time without rewriting the whole episodic file.

The cost: more files, schema migration burden, breaking change to
`EpisodicMemory` consumers. We accept the cost because the alternative
(stay at v1) leaves the four-layer model under-using its own episodic
slot.

This concept is the GKS-native distillation of EVA-Episodic-Memory-v2
with all EVA cognitive paradigm (RMS, ESS, EVA matrix) stripped — see
ADR--EPISODIC-V2 for the per-field decision rationale.
