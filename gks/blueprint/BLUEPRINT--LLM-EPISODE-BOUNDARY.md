---
id: BLUEPRINT--LLM-EPISODE-BOUNDARY
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — LLM episode boundary detector
crosslinks: {"parent_adr":["ADR--LLM-EPISODE-BOUNDARY"],"parent_concept":["CONCEPT--LLM-EPISODE-BOUNDARY"]}
linked_symbols:
  - {"file":"src/memory/episode-boundary-llm.ts","fn":"createLlmBoundaryDetector"}
  - {"file":"src/memory/episode-boundary.ts"}
created_at: 2026-05-02T13:29:41.624Z
---

# BLUEPRINT — LLM episode boundary detector

```yaml
metadata:
  title: "LLM-backed pluggable boundary detector"
  status: draft

architectural_pattern: |
  Factory `createLlmBoundaryDetector(opts)` returns an
  EpisodeBoundaryDetector. Internally: run the heuristic detector
  first to get the deterministic baseline, then call the LLM with the
  whole trace to ask for ADDITIONAL topic-shift boundaries. Merge
  both segment lists, dedupe by start_index, return.

data_logic: |
  createLlmBoundaryDetector(opts):
    return async (trace) => {
      // Step 1 — Heuristic baseline (deterministic, cheap)
      const heuristic = await detectEpisodeBoundaries(trace, opts.heuristic ?? {})

      // Step 2 — Bail on long traces
      if (trace.length > (opts.maxTurnsInPrompt ?? 200)) {
        log.warn('llm boundary: trace too long, using heuristic only', {len: trace.length})
        return heuristic
      }

      // Step 3 — LLM call (with retry + parsing)
      const prompt = buildPrompt(trace, opts.excerptChars ?? 200)
      let llmIndices: { idx: number; reason?: string }[] = []
      try:
        const raw = await opts.client.generate({
          system: SYSTEM_PROMPT,
          user: prompt,
          maxTokens: opts.maxResponseTokens ?? 256,
        })
        llmIndices = parseLlmResponse(raw, trace.length)
      catch err:
        log.warn('llm boundary: call failed, heuristic only', {err})
        return heuristic

      // Step 4 — Merge: build a Map<start_index, segment-info>, prefer
      // heuristic reason on tie. Then walk indices sorted ascending and
      // emit segments [start, nextStart) preserving signals.
      return mergeSegments(heuristic, llmIndices, trace.length)
    }

  parseLlmResponse(raw, traceLen):
    Strips fenced JSON, parses, validates indices in [1, traceLen-1],
    dedupes, returns sorted array of {idx, reason?}. Empty/malformed →
    return [].

geography:
  - "src/memory/episode-boundary-llm.ts"     # NEW: factory + helpers
  - "src/memory/episode-boundary.ts"          # ensure exports compose
  - "src/memory/index.ts"                     # re-export
  - "test/memory/episode-boundary-llm.test.ts" # NEW

api_contracts:
  - name: "LlmBoundaryDetectorOptions"
    file: "src/memory/episode-boundary-llm.ts"
    shape: |
      interface LlmBoundaryDetectorOptions {
        client: LlmClient
        heuristic?: EpisodeBoundaryOptions  // forwarded to default detector
        maxTurnsInPrompt?: number           // default 200
        excerptChars?: number               // default 200 chars/turn
        maxResponseTokens?: number          // default 256
      }
  - name: "createLlmBoundaryDetector"
    file: "src/memory/episode-boundary-llm.ts"
    shape: |
      function createLlmBoundaryDetector(
        opts: LlmBoundaryDetectorOptions,
      ): EpisodeBoundaryDetector

verification_plan:
  - id: V1-llm-only-no-heuristic
    description: |
      Mock LlmClient returns boundaries=[2]. heuristic disabled
      (timeGap + explicit off). Result has 2 segments: [0,2), [2,end).
      Reason on second segment is 'topic-shift', signals.llm_reason
      carries the parsed string.
  - id: V2-merge-with-heuristic
    description: |
      Mock LLM returns [2]; trace has time-gap at index 5. Result
      has 3 segments: [0,2), [2,5), [5,end). Heuristic time-gap
      reason wins on segment 3.
  - id: V3-llm-failure-fallback
    description: |
      LLM client throws. Detector returns heuristic-only result;
      no exception propagates.
  - id: V4-malformed-response-fallback
    description: |
      LLM returns 'not json'. Detector returns heuristic-only result.
  - id: V5-out-of-range-clamped
    description: |
      LLM returns boundaries=[0, 999, -3, 5]. Only valid in-range
      indices contribute (0 + out-of-range dropped; negatives dropped).
  - id: V6-too-long-trace-bails
    description: |
      Trace length > maxTurnsInPrompt → LLM is NOT called; result is
      heuristic-only.
  - id: V7-end-to-end-via-endSession
    description: |
      endSession({ episodeBoundary: { detector: createLlmBoundaryDetector(...) } })
      writes Episodes per the merged segment list. Provenance carries
      llm_reason where the LLM contributed.

implementation_steps:
  - 1. Build src/memory/episode-boundary-llm.ts: SYSTEM_PROMPT,
       buildPrompt, parseLlmResponse, mergeSegments, factory.
  - 2. Re-export createLlmBoundaryDetector from src/memory/index.ts.
  - 3. Tests V1-V7 with mock LlmClient. No real LLM calls in CI.
```
