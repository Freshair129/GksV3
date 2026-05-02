---
id: CONCEPT--LLM-EPISODE-BOUNDARY
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — LLM-based episode boundary detection
crosslinks: {"references":["CONCEPT--EPISODE-BOUNDARY"]}
created_at: 2026-05-02T13:29:38.410Z
---

# CONCEPT — LLM-based episode boundary detection

## Problem

The default episode boundary detector
([[CONCEPT--EPISODE-BOUNDARY]] / BLUEPRINT--EPISODE-BOUNDARY) uses
three composable signals: time-gap, explicit marker, and (opt-in)
semantic cosine. The semantic path is the only "topic-aware" signal
and it depends entirely on a small fixed-threshold over
embedder cosine similarity. That's good enough to catch obvious
shifts — but misses subtler ones:

- "Let's debug auth" → "Let's discuss the architecture for the new feature"
  (both technical, embeddings cluster together)
- A long thread where each turn references the prior turn but the
  *underlying topic* drifts gradually
- Multilingual conversations where embedder cosine is unreliable

ADR--EPISODE-BOUNDARY explicitly deferred LLM-based detection:
> "LLM-based boundary detection by default. *Rejected.* Couples GKS
> to LLM availability... Pluggable for callers who want it."

But the BLUEPRINT also exposed the `EpisodeBoundaryDetector`
function-shape contract (`EndSessionOptions.episodeBoundary.detector`)
specifically so this kind of detector could plug in without touching
the storage path. We just haven't shipped the LLM-backed
implementation yet.

## Hypothesis

If GKS exports a `createLlmBoundaryDetector(opts)` factory that
returns an `EpisodeBoundaryDetector` (the same type endSession
already accepts via `episodeBoundary.detector`), then:

1. Callers who want richer detection can wire it in with one option
   on `endSession`:
   ```ts
   await endSession(store, session, {
     episodeBoundary: { detector: createLlmBoundaryDetector({ client }) },
   })
   ```
2. The detector stays out of the default path — no impact on
   callers without an LLM client configured.
3. Behaviour is composable: the LLM detector internally combines
   its own decisions with the heuristic detector's results
   (time-gap + explicit marker), so deterministic high-confidence
   signals still win.

The cost: one LLM call per end-of-session (sees the whole trace).
For a 50-turn session the input is ~5K tokens; output is a
list-of-indices JSON ~50 tokens. With the local SLM consolidator
already available (`createOpenAICompatibleClient`), this runs at
$0 marginal cost on a typical local-first setup.

This is a strict additive — the existing default detector keeps
working unchanged; the LLM path is an opt-in choice for callers who
want better recall on subtle topic shifts.
