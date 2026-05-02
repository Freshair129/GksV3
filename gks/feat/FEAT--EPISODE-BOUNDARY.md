---
id: FEAT--EPISODE-BOUNDARY
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Episode boundary detection
crosslinks: {"parent_concept":["CONCEPT--EPISODE-BOUNDARY"],"parent_adr":["ADR--EPISODE-BOUNDARY"],"parent_blueprint":["BLUEPRINT--EPISODE-BOUNDARY"]}
linked_symbols:
  - {"file":"src/memory/episode-boundary.ts","fn":"detectEpisodeBoundaries"}
  - {"file":"src/memory/session.ts","fn":"writeEpisodicV2"}
created_at: 2026-05-02T09:42:42.248Z
---

# FEAT — Episode boundary detection

## User-facing behaviour

> Given a session whose trace has a 15-minute pause between turns,
> when `endSession` runs (with default options),
> then the v2 episodic store gets **two** Episodes — turns before
> the gap in `E-<session>-001`, turns after the gap in `E-<session>-002`.
> Each Episode carries `provenance.episode_reason: 'time-gap'`.

> Given a developer who passes a system trace step with
> `metadata.episode_boundary: true` at index k,
> when endSession runs,
> then the trace splits at k regardless of timing.

> Given a developer who wants semantic boundaries,
> when they pass `episodeBoundary: { semantic: { enabled: true } }`,
> then the embedder is invoked once per turn and boundaries fire
> when `cosine(t[i], t[i+1]) < similarityFloor`.

> Given a caller that wants the legacy single-episode behaviour,
> when they pass `episodeBoundary: false`,
> then writeEpisodicV2 emits exactly one Episode (matches the
> pre-change implementation byte-for-byte).

## Acceptance criteria

- [ ] **AC1**: `src/memory/episode-boundary.ts` exports
      `detectEpisodeBoundaries(trace, opts?)`,
      `EpisodeBoundaryOptions`, `EpisodeSegment` per BLUEPRINT.
- [ ] **AC2**: Default options: time-gap=true (10 min),
      explicit=true, semantic=false. Time-gap + explicit fire
      without any embedder dependency.
- [ ] **AC3**: A trace with a single time-gap > 10 min produces
      exactly 2 segments; the gap location matches the trace
      timestamps.
- [ ] **AC4**: A `kind: 'system'` step with
      `metadata.episode_boundary: true` produces a boundary at that
      index (regardless of timing).
- [ ] **AC5**: With `semantic: { enabled: true, embedder }` and a
      stubbed embedder, semantic boundaries fire when consecutive
      turn vectors fall below `similarityFloor` (default 0.55).
- [ ] **AC6**: Each `EpisodeSegment` carries `reason` and `signals`
      (`gapMs` for time-gap; `cosine` for topic-shift). The
      `Episode.provenance` written to disk includes
      `episode_reason` and `episode_signals` so audits can
      reconstruct *why* a boundary fired.
- [ ] **AC7**: `endSession({ episodeBoundary: false })` reproduces
      the legacy single-episode behaviour byte-for-byte. Existing
      session.test.ts cases pass unmodified.
- [ ] **AC8**: `endSession({ episodeBoundary: { detector } })`
      uses the supplied detector — the default detector is not
      called.
- [ ] **AC9**: Episode ids are `E-<session_id>-NNN` with N
      zero-padded to 3 digits in segment order.
- [ ] **AC10**: 7 verification scenarios from BLUEPRINT (V1-V7)
      ship as automated tests in `test/memory/episode-boundary.test.ts`
      plus a session-level integration test in `session.test.ts`.

## Out of scope

- LLM-based boundary detection (callers can supply a custom
  detector if they want it).
- Re-bucketing existing v2 sessions (the migration is forward-only
  on new endSession calls).
- Adaptive thresholds based on session length / corpus statistics —
  fixed defaults + per-call override is sufficient.
- Per-Episode semantic_frames inference — that's the consolidator's
  job, not the boundary detector's.
