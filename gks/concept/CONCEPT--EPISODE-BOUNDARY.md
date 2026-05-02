---
id: CONCEPT--EPISODE-BOUNDARY
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Episode boundary detection
crosslinks: {"references":["CONCEPT--MEMORY-STORE","CONCEPT--EPISODIC-V2"]}
created_at: 2026-05-02T09:42:38.604Z
---

# CONCEPT — Episode boundary detection

## Problem

EPISODIC-V2 (commit b7991e5) splits each session into Episodes — but
`endSession.writeEpisodicV2` currently emits **one** Episode per
session: every TraceStep becomes a Turn under a single
`E-<session_id>-001`. This is the conservative default the
BLUEPRINT explicitly chose:

> "Episode boundary detection is a follow-up — until then, one
> episode per session is the safe default."

The cost: agents and tools that recall by Episode see one giant
container with 100+ turns spanning multiple unrelated topics. That
defeats the whole point of having Episodes at all — the layer was
designed to hold **context-coherent slices**, not whole sessions.

A 2-hour session that:
1. Debugs an authentication issue (turns 1–20)
2. Pivots to discussing architecture (turns 21–60)
3. Ends with casual chat (turns 61–80)

…should land as **3 Episodes**, each with its own
`situation_context` and crosslinks. Instead it lands as one Episode
where every recall query about "auth debugging" pulls in 60 turns of
unrelated material.

## Hypothesis

If `endSession` (and a standalone helper for offline use) detect
Episode boundaries from a trace using a small set of cheap signals:

1. **Time gap** — large pause between consecutive turns
2. **Topic shift** — semantic distance between consecutive turn
   embeddings exceeds a threshold
3. **Explicit marker** — a TraceStep with `kind === 'system'` and
   metadata `episode_boundary: true`

…and emit one Episode per detected segment, then:

- Recall on Episodes returns coherent slices, not whole sessions.
- Per-Episode `situation_context` and crosslinks become meaningful
  signals (different stakes_level for "debug" vs "casual chat").
- `summarizeCommunity({ seed: episode_id })` and the new
  `lookupByAtom` reverse lookup get tighter results.

The cost: one extra pass over the trace at endSession. With the
local nomic embedder already in the loop, semantic boundary detection
adds ~50ms per trace step. Time-gap and explicit-marker detection
are zero-cost.

This is the natural completion of EPISODIC-V2 — the schema already
supports multiple Episodes per session; we just need to emit them
when they exist.
