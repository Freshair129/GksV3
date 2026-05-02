---
id: ADR--SEMANTIC-FRAMES
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Per-turn semantic_frames inferrer
crosslinks: {"parent_concept":["CONCEPT--SEMANTIC-FRAMES"],"references":["ADR--EPISODIC-V2","ADR--LLM-EPISODE-BOUNDARY"]}
created_at: 2026-05-02T13:34:40.648Z
---

# ADR — Per-turn semantic_frames inferrer

## Context

[[CONCEPT--SEMANTIC-FRAMES]] motivates wiring a producer for the
v2 Turn `semantic_frames` field. Open questions:

1. **Heuristic-only or LLM-backed?**
2. **Inline at appendTurn, or batch at endSession?**
3. **Where does the inferrer live + what's the API?**

## Decision

### 1. Both — heuristic default, LLM opt-in (matching the established pattern)

Two implementations, behind one factory pattern that mirrors what
the TLDR + boundary detector layers ship:

```ts
type SemanticFramesInferrer = (
  trace: TraceStep[],
) => Promise<{ frames: (string[] | undefined)[] }>

createHeuristicSemanticFramesInferrer(): SemanticFramesInferrer
createLlmSemanticFramesInferrer(opts): SemanticFramesInferrer
```

The returned array is parallel to `trace[]` — `frames[i]` is the
list for `trace[i]`, or `undefined` if no frames could be inferred.

**Heuristic** maps `TraceStep.kind` + simple text patterns:
- `kind: 'user'` + `?` in content → `['question']`
- `kind: 'user'` + imperative starter (Please, Make, Can you) → `['request']`
- `kind: 'agent'` + first-line code-fence → `['explanation', 'demonstration']`
- `kind: 'tool'` → `['action']`
- `kind: 'system'` → `['system_event']`
- `kind: 'memory'` / `'brain'` → `['recall']`
- default → undefined

Deterministic, zero-cost, and produces useful defaults without an
LLM. Catches ~70% of common conversational frames in our existing
fixtures.

**LLM-backed** sends the whole trace in one call, asks for a
JSON-array-of-arrays (1-4 frames per turn, lowercase), parses
defensively, falls back to heuristic on failure (same posture as
LLM-EPISODE-BOUNDARY).

### 2. Batch at endSession, not inline at appendTurn

`appendTurn` is hot — agents flush turns one at a time during long
sessions. Adding an LLM call (or even a heuristic one) inline would
slow that path. End-of-session is where consolidation already
happens — frames inference fits naturally there.

The downside: turns appended via direct `appendTurn` calls (without
ending the session through `endSession`) won't get frames. Acceptable
— that's a manual / low-level path; agents using the standard flow
get frames as a side-effect of `endSession`.

### 3. New module `src/memory/semantic-frames.ts`

Lives next to `episode-boundary.ts` / `episode-boundary-llm.ts` —
matches the layout pattern. Public exports include both factories +
the `SemanticFramesInferrer` type. `EndSessionOptions` gains:

```ts
interface EndSessionOptions {
  // existing …
  semanticFrames?: false | SemanticFramesInferrer
}
```

- `false` → no frames (default if undefined too — opt-in)
- `undefined` → no frames (matches today's behaviour byte-for-byte)
- `<inferrer>` → run that inferrer post-write, patch each Turn's
  frames into `turns.jsonl`

The patch step requires rewriting `turns.jsonl` once at end-of-session
(same kind of rewrite the boundary detector already triggers). Append-
only invariant for individual `appendTurn` calls is preserved.

## Consequences

**Positive:**
- The `semantic_frames` field finally has a producer — recall +
  reverse-lookup get structured signal.
- Pluggable: heuristic for offline / single-tenant; LLM for richer
  inference.
- Zero cost when not opted in (default behaviour unchanged).

**Negative:**
- LLM call adds a few seconds at end-of-session when wired in.
  Mitigated by opt-in default.
- Single rewrite of `turns.jsonl` at end-of-session breaks the
  strict append-only invariant for that one moment. Acceptable —
  same tradeoff endSession already made for episodes.jsonl when
  boundary detection split a session into multiple Episodes.

**Schema impact:** none on disk. The field already exists in v2.

## Alternatives considered

1. **Inline inference at appendTurn.** *Rejected.* Hot path; would
   slow streaming agents. Batch at endSession is correct.
2. **Per-turn LLM call.** *Rejected.* N calls vs one whole-trace
   call. Whole-trace gives the model context to disambiguate
   (e.g., a `?` in a code snippet ≠ a question).
3. **Use NLP libraries (spaCy, etc.) for frame parsing.**
   *Rejected.* Adds heavy deps; the heuristic + LLM combo covers
   the use cases we have.
4. **Stamp frames at appendEpisode time** (one frame array per
   episode, not per turn). *Rejected.* Loses turn-level granularity;
   the schema already chose per-turn.
