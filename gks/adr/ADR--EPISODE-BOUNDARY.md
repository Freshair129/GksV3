---
id: ADR--EPISODE-BOUNDARY
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Episode boundary detection
crosslinks: {"parent_concept":["CONCEPT--EPISODE-BOUNDARY"],"references":["ADR--EPISODIC-V2"]}
created_at: 2026-05-02T09:42:39.818Z
---

# ADR — Episode boundary detection

## Context

[[CONCEPT--EPISODE-BOUNDARY]] motivates splitting a TraceStep[] into
multiple Episodes. Open questions:

1. **What signals trigger a boundary?**
2. **What are the defaults — fire-eagerly or fire-conservatively?**
3. **Should detection block endSession or run async?**
4. **API shape — pluggable detector, or hardcoded?**

## Decision

### 1. Three composable signals (any-fires)

A boundary is declared between turns `i` and `i+1` if **any** of:

a. **Time gap**: `t[i+1] - t[i] > timeGapMs`
   (default: 10 minutes = 600_000 ms)
b. **Topic shift**: `cosine(embed(turn[i]), embed(turn[i+1])) < topicSimilarityFloor`
   (default: 0.55 — tuned for nomic 768-dim; conservative)
c. **Explicit marker**: `turn[i+1].kind === 'system'` and
   `turn[i+1].metadata?.episode_boundary === true`

The OR semantics keep the detector robust — any single strong signal
fires, no per-signal weight tuning. Disable per-signal via opts.

### 2. Default: time-gap + explicit-marker enabled, semantic OFF

Semantic detection requires running the embedder N-1 times per
session (one per consecutive turn pair). At ~50ms each on local
nomic, that's seconds for any real session. We don't want to make
every endSession depend on embedder availability + add ~5s of
latency by default.

Default config:
```ts
{
  timeGap:    { enabled: true,  thresholdMs: 600_000 },
  semantic:   { enabled: false, similarityFloor: 0.55, topK: 3 },
  explicit:   { enabled: true },
  minTurnsPerEpisode: 1,        // any segment, including singletons
}
```

Callers opt into semantic via `endSession({ episodeBoundary:
{ semantic: { enabled: true } } })` or by configuring it on the
MemoryStore.

### 3. Synchronous in endSession

Boundary detection runs inline before `appendEpisode/appendTurn`
calls so the writes go to the right Episode from the start. The
alternative (write to one Episode, post-hoc split) duplicates work
and complicates the FK relationship.

Synchronous default is acceptable because:
- Time-gap + explicit-marker = O(N) string compare, ~µs per trace.
- Semantic (when enabled) is ~50ms × N — opt-in, so callers who turn
  it on accept the cost.

### 4. Pluggable detector function

Default detector is exported from `src/memory/episode-boundary.ts`.
Callers who want different signals (e.g., LLM-based topic detection,
custom heuristics) supply their own:

```ts
type EpisodeBoundaryDetector = (trace: TraceStep[]) => Promise<EpisodeSegment[]>

interface EpisodeSegment {
  start_index: number     // inclusive
  end_index: number       // exclusive
  reason: 'initial' | 'time-gap' | 'topic-shift' | 'explicit' | 'fallback'
  signals: { gapMs?: number; cosine?: number }
}
```

`endSession` accepts `episodeBoundary: { detector } | { ...config }
| false` (false = legacy single-episode mode).

## Consequences

**Positive:**
- Sessions split into context-coherent Episodes; recall + reverse
  lookup get tighter results.
- Defaults stay cheap (no embedder dependency in the hot path).
- Pluggable detector — orchestrators can layer LLM-based detection
  later without touching GKS internals.
- Each segment carries `reason` + `signals` so callers can audit
  *why* a boundary fired.

**Negative:**
- Adds an opt-in semantic path that takes a runtime dependency on
  the embedder. Mitigated by the OFF-by-default config.
- Boundary thresholds are workload-dependent (10 min gap might be
  wrong for batch agents). Documented as knobs.
- Episode count grows; downstream consumers iterating Episodes
  see N×.

**Schema impact:** none on the wire. New optional config on
`endSession`/`writeEpisodicV2`.

## Alternatives considered

1. **Run boundary detection asynchronously in a sidecar process.**
   *Rejected.* Adds operational complexity; sync detection at
   endSession is fast enough.

2. **LLM-based boundary detection by default.** *Rejected.* Couples
   GKS to LLM availability, and the heuristic signals already cover
   the common cases (time gap, explicit marker). Pluggable for
   callers who want it.

3. **Single weighted score combining all signals.** *Rejected.*
   Tuning weights is harder than tuning per-signal thresholds. OR
   semantics gives a clean enable/disable knob per signal.

4. **Always emit one Episode (status quo).** *Rejected.* Defeats
   the V2 schema's purpose; explicitly identified as deferred work
   in BLUEPRINT--EPISODIC-V2.

5. **Detect boundaries post-hoc on demand** (run on stored trace.jsonl
   when the user asks). *Rejected.* Doubles the storage (you'd want
   both the original Episode and the rewritten ones); endSession
   already has the trace in memory and is the natural inflection
   point.
