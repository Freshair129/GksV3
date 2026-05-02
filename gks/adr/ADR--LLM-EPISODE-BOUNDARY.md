---
id: ADR--LLM-EPISODE-BOUNDARY
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — LLM-based episode boundary detector
crosslinks: {"parent_concept":["CONCEPT--LLM-EPISODE-BOUNDARY"],"references":["ADR--EPISODE-BOUNDARY"]}
created_at: 2026-05-02T13:29:39.971Z
---

# ADR — LLM-based episode boundary detector

## Context

[[CONCEPT--LLM-EPISODE-BOUNDARY]] motivates an opt-in LLM-backed
boundary detector. Open questions:

1. **What's the prompt + response shape?**
2. **How does it compose with the heuristic signals?**
3. **What's the failure mode (LLM unreachable / malformed output)?**
4. **One call or per-pair?**

## Decision

### 1. Single whole-trace prompt; JSON-array response

The detector sends the **entire trace** in one LLM call. Each turn is
serialised as one line `[N] <speaker>: <text-excerpt>`. The model is
asked to return a JSON array of indices where boundaries occur:

```jsonc
{ "boundaries": [12, 27, 41] }
```

The model also returns a one-line reason per index in a parallel
array, which we stamp into `EpisodeSegment.signals.llm_reason` for
audit:

```jsonc
{ "boundaries": [12, 27, 41], "reasons": ["topic shift to debug",
  "casual chat", "back to feature"] }
```

Whole-trace prompt is preferred over per-pair because:
- LLM reads context on either side and makes a global judgment
- One call vs N-1 calls — much cheaper on token + latency
- 50-turn sessions fit in any 8K context easily

### 2. Composition with heuristic signals

The detector internally calls the **default heuristic detector**
first (time-gap + explicit-marker), takes those boundary indices,
then asks the LLM for additional topic-shift boundaries. The
final segment list is the **union** of both, dedupe-merged.

Reason for this layering:
- Time-gap and explicit markers are deterministic high-confidence
  signals; they MUST always fire regardless of what the LLM says.
- The LLM only contributes "subtle topic shift" boundaries the
  heuristics miss.
- If the LLM call fails, the heuristic boundaries still produce a
  reasonable segmentation.

Each segment carries `reason` set by the *first* signal that fired
on it (priority: explicit > time-gap > topic-shift > llm > initial).

### 3. Failure modes

- **LLM call throws** (network, timeout) → log warning, fall back
  to heuristic-only result. No re-throw.
- **LLM returns malformed JSON** → fall back to heuristic. Log a
  preview of the bad output (truncated, redacted).
- **LLM returns indices outside [1, trace.length-1]** → clamp +
  drop invalid indices.
- **LLM returns the same index multiple times** → dedupe.

Failure NEVER blocks endSession. Worst case the result equals what
the default detector produces.

### 4. One call or per-pair

One whole-trace call wins on latency, cost, and quality (global
context). Per-pair was considered but rejected — would need
N-1 calls for a sliding window of just two messages, which is too
narrow for the LLM to make good calls.

For very long traces (>200 turns), the prompt could exceed reasonable
limits. The detector caps at `maxTurnsInPrompt` (default 200, takes
the most recent N) — beyond that, the heuristic-only result is
returned. Callers needing better can chunk the trace themselves and
combine results.

## Consequences

**Positive:**
- Better recall on subtle topic shifts (different domain, gradual
  drift, multilingual)
- Heuristic baseline preserved — no regression when LLM fails
- Composes via the existing `episodeBoundary.detector` plug point
  — zero changes to session.ts beyond what already shipped

**Negative:**
- One LLM call per endSession when wired in. Mitigated by opt-in
  default + bounded prompt size.
- LLM judgment is non-deterministic; same trace can yield slightly
  different boundary sets across runs. Acceptable for the layer
  this serves (recall-style queries, not audit-style).

**Schema impact:** none. New module + factory function.

## Alternatives considered

1. **Per-pair LLM calls.** *Rejected.* Too many calls + narrow
   context; whole-trace gives the model what it needs in one shot.
2. **Replace the default detector entirely with LLM.** *Rejected.*
   Couples GKS to LLM availability + non-determinism. Layered
   approach is strictly better.
3. **Cache LLM boundary decisions per trace hash.** *Deferred.*
   Reasonable optimisation; defer until measured demand justifies
   the cache complexity.
4. **Use `summary_tldr` per turn instead of raw text.** *Rejected.*
   Turns don't have TLDRs; that's an atom-level field.
