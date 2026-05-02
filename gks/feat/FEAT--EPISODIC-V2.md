---
id: FEAT--EPISODIC-V2
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Episodic memory v2
crosslinks: {"parent_concept":["CONCEPT--EPISODIC-V2"],"parent_adr":["ADR--EPISODIC-V2"],"parent_blueprint":["BLUEPRINT--EPISODIC-V2"]}
linked_symbols:
  - {"file":"src/memory/types.ts"}
  - {"file":"src/memory/episodic.ts","fn":"EpisodicLayer"}
  - {"file":"src/memory/episodic-v2.ts"}
  - {"file":"src/memory/session.ts","fn":"endSession"}
created_at: 2026-05-02T05:57:37.332Z
---

# FEAT — Episodic memory v2

## User-facing behaviour

> Given a developer holding a `MemoryStore` instance,
> when they run a session through `startSession` + `appendTrace` +
> `endSession`,
> then the resulting episodic record on disk is the v2 three-document
> form: `<session_id>/session.json` + `episodes.jsonl` + `turns.jsonl`,
> with `schema_version: "2.0.0"` on the session header.

> Given the same developer reading a v1 session that pre-dates this
> change,
> when they call `EpisodicLayer.read(v1SessionId)`,
> then GKS detects the legacy shape and returns the original
> `EpisodicMemory` form transparently — no migration required to
> read.

> Given a streaming agent appending one turn at a time during a long
> session,
> when each `appendTurn` lands,
> then `turns.jsonl` grows by exactly one line and existing lines are
> byte-identical (true append-only — no rewrite race).

> Given an episode with crosslinks `{ "discusses": ["FEAT--FOO"],
> "inspired_by": ["INSIGHT--BAR"] }`,
> when `gks validate --links` runs,
> then `discusses → FEAT--FOO` is validated against the atom index
> (errors if missing) and `inspired_by → INSIGHT--BAR` passes
> through with a warning (unknown predicate, not a failure).

## Acceptance criteria

- [ ] **AC1**: New types `EpisodicSession`, `Episode`, `Turn`,
      `EpisodicCrosslinks`, and `CORE_EPISODIC_PREDICATES` exist in
      `src/memory/types.ts` per the BLUEPRINT shape.
- [ ] **AC2**: `src/memory/episodic-v2.ts` exports `EpisodicLayerV2`
      with read/write methods (`readSession`, `listEpisodes`,
      `listTurns`, `appendTurn`, `appendEpisode`, `writeSession`,
      `finaliseSession`).
- [ ] **AC3**: Disk layout is `<episodicDir>/<session_id>/{session.json,
      episodes.jsonl, turns.jsonl}`. `_index.jsonl` lives at
      `<episodicDir>/_index.jsonl`.
- [ ] **AC4**: `EpisodicLayer` (existing v1 class) gains a v2 dispatch
      so `read(sessionId)` transparently returns either v1 or v2 shape.
      No existing v1 test regresses.
- [ ] **AC5**: `appendTurn` is true append-only — opens `turns.jsonl` in
      `'a'` mode and writes a single newline-terminated JSON object.
      Verified by byte-comparing the file before/after.
- [ ] **AC6**: `Turn.episode_id` is the FK source of truth.
      `listTurns(sessionId, episodeId)` returns only turns whose
      `episode_id === episodeId`.
- [ ] **AC7**: `appendTurn` updates the matching Episode's
      denormalised `turn_count`, `last_turn_id`, `ended_at` (via
      single-pass rewrite of `episodes.jsonl` — acceptable because
      episode count ≪ turn count).
- [ ] **AC8**: `validateLinks` walks episode + turn `crosslinks`
      using `CORE_EPISODIC_PREDICATES` for validation; unknown
      predicates pass with a warning.
- [ ] **AC9**: `endSession` defaults to v2; legacy callers pass
      `endSession({ schemaVersion: '1' })` to opt back. Default
      output for new sessions is v2.
- [ ] **AC10**: `finaliseSession` updates `_index.jsonl` idempotently
      (no duplicate `session_id` rows).
- [ ] **AC11**: 7 verification scenarios from BLUEPRINT (V1–V7) ship
      as automated tests in `test/memory/episodic-v2.test.ts`. No
      existing test regresses; total count strictly increases.

## Out of scope

- `gks episodic migrate` CLI (re-emit v1 → v2). Separate follow-up.
- `gks episodic show` CLI for human inspection. Separate follow-up.
- Reverse index for episode crosslinks (`lookupBySymbol`-style for
  episodes). Separate follow-up.
- Edge attribute objects (e.g. `{target, since, strength}`). Deferred
  per ADR alternative 4.
- Per-turn semantic embeddings (vector layer integration for turns).
  Separate concept.
- Cross-session episode walking. Within-session for now.
