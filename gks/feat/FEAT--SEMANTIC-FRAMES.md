---
id: FEAT--SEMANTIC-FRAMES
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Per-turn semantic_frames inference
crosslinks: {"parent_concept":["CONCEPT--SEMANTIC-FRAMES"],"parent_adr":["ADR--SEMANTIC-FRAMES"],"parent_blueprint":["BLUEPRINT--SEMANTIC-FRAMES"]}
linked_symbols:
  - {"file":"src/memory/semantic-frames.ts"}
  - {"file":"src/memory/episodic-v2.ts","fn":"EpisodicLayerV2.patchTurnFrames"}
  - {"file":"src/memory/session.ts"}
created_at: 2026-05-02T13:34:43.906Z
---

# FEAT — Per-turn semantic_frames inference

## User-facing behaviour

> Given a developer who wants structured frame tags on every Turn,
> when they pass `semanticFrames: createHeuristicSemanticFramesInferrer()`
> to `endSession`,
> then GKS infers a frame array per turn from `kind` + simple text
> patterns and stamps it into `turns.jsonl` (e.g.,
> `kind='user'` + "Make X" → `['request']`).

> Given a developer with an LLM client configured,
> when they pass `semanticFrames: createLlmSemanticFramesInferrer({ client })`,
> then GKS sends the whole trace in one LLM call, parses the
> array-of-arrays response, and stamps the LLM's frames per turn.
> If the LLM fails or returns the wrong shape, the heuristic fallback
> populates instead.

> Given the default behaviour (no `semanticFrames` option),
> when endSession runs,
> then turns are written without `semantic_frames` populated —
> byte-identical to the pre-change behaviour.

## Acceptance criteria

- [ ] **AC1**: `src/memory/semantic-frames.ts` exports
      `createHeuristicSemanticFramesInferrer`,
      `createLlmSemanticFramesInferrer`, and the
      `SemanticFramesInferrer` type per BLUEPRINT.
- [ ] **AC2**: Heuristic inferrer returns deterministic frames for
      common cases (`question` / `request` / `statement` / `action` /
      `system_event` / `recall` / `explanation`).
- [ ] **AC3**: LLM inferrer sends the whole trace in ONE call, parses
      `{"frames": [[...], [...], ...]}` defensively (strips fences,
      validates length matches trace length, drops invalid items).
- [ ] **AC4**: LLM failure (throw / shape mismatch / malformed JSON)
      → falls back to the configured `fallback` inferrer (default =
      heuristic).
- [ ] **AC5**: Trace longer than `maxTurnsInPrompt` (default 200) →
      LLM is NOT called; fallback runs instead.
- [ ] **AC6**: `EpisodicLayerV2.patchTurnFrames(sessionId,
      framesPerTurn)` rewrites `turns.jsonl` once with the new frames.
      Length-mismatch throws.
- [ ] **AC7**: `endSession({ semanticFrames: <inferrer> })` calls the
      inferrer after appending turns and before `finaliseSession`.
      Resulting `turns.jsonl` has `semantic_frames` populated.
- [ ] **AC8**: Default behaviour (no option, or `semanticFrames:
      false`) is byte-identical to today — every existing
      session.test.ts case passes unmodified.
- [ ] **AC9**: Public re-exports from `src/memory/index.ts` for both
      factories + the type.
- [ ] **AC10**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests in `test/memory/semantic-frames.test.ts`.

## Out of scope

- FrameNet integration (mapping to standard frame names)
- Per-Episode aggregate frames (rollup of per-turn frames)
- Filtering recall results by frame (callers can do this on the
  returned hits today)
- Inline inference at appendTurn — rejected in ADR (hot path)
