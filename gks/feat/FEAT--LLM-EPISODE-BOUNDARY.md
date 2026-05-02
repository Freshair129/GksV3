---
id: FEAT--LLM-EPISODE-BOUNDARY
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — LLM episode boundary detector
crosslinks: {"parent_concept":["CONCEPT--LLM-EPISODE-BOUNDARY"],"parent_adr":["ADR--LLM-EPISODE-BOUNDARY"],"parent_blueprint":["BLUEPRINT--LLM-EPISODE-BOUNDARY"]}
linked_symbols:
  - {"file":"src/memory/episode-boundary-llm.ts","fn":"createLlmBoundaryDetector"}
created_at: 2026-05-02T13:29:43.189Z
---

# FEAT — LLM episode boundary detector

## User-facing behaviour

> Given a developer with a configured `LlmClient`,
> when they pass `episodeBoundary: { detector: createLlmBoundaryDetector({ client }) }`
> to `endSession`,
> then GKS calls the LLM once at end-of-session with the whole trace,
> merges the LLM's topic-shift boundaries with the deterministic
> heuristic baseline (time-gap + explicit), and writes one Episode
> per merged segment.

> Given the LLM call fails (network, timeout, malformed JSON),
> when endSession runs,
> then the detector falls back to the heuristic-only result —
> no exception propagates, endSession completes normally.

## Acceptance criteria

- [ ] **AC1**: `src/memory/episode-boundary-llm.ts` exports
      `createLlmBoundaryDetector(opts)` per BLUEPRINT.
- [ ] **AC2**: Returned detector matches the
      `EpisodeBoundaryDetector` type — `endSession({ episodeBoundary:
      { detector } })` accepts it without other changes.
- [ ] **AC3**: The detector always runs the heuristic baseline first
      and merges LLM results on top.
- [ ] **AC4**: LLM failure (thrown error) → log warning, return
      heuristic-only result; no exception propagates.
- [ ] **AC5**: Malformed LLM output (not JSON / wrong schema) →
      same fallback as AC4.
- [ ] **AC6**: Out-of-range LLM indices (`<= 0` or `>= traceLen`)
      are clamped/dropped silently.
- [ ] **AC7**: Trace longer than `maxTurnsInPrompt` (default 200)
      → LLM is NOT called; heuristic-only result returned with a
      warning log.
- [ ] **AC8**: Each LLM-contributed segment carries
      `signals.llm_reason` (when the LLM provided one) so audits
      can see *why* the boundary fired.
- [ ] **AC9**: `createLlmBoundaryDetector` is exported from
      `src/memory/index.ts` so callers can import it without reaching
      into the internal module.
- [ ] **AC10**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests with a mock LlmClient. No real LLM calls in
      CI.

## Out of scope

- Caching LLM boundary decisions per trace hash (deferred —
  `summarizeCommunity` already has a similar pattern via
  PERSISTED-COMMUNITY).
- Per-pair LLM detection (rejected in ADR — whole-trace is better).
- Batched calls for multiple sessions in one prompt (premature).
- An MCP tool for boundary detection — boundary detection runs
  inline at endSession; no agent-driving use case justifies a
  separate tool surface.
