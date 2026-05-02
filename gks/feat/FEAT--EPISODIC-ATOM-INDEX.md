---
id: FEAT--EPISODIC-ATOM-INDEX
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Persisted episodic atom-refs index
crosslinks: {"parent_concept":["CONCEPT--EPISODIC-ATOM-INDEX"],"parent_adr":["ADR--EPISODIC-ATOM-INDEX"],"parent_blueprint":["BLUEPRINT--EPISODIC-ATOM-INDEX"]}
linked_symbols:
  - {"file":"src/memory/episodic-atom-index.ts"}
  - {"file":"src/memory/episodic-v2.ts"}
  - {"file":"bin/gks.ts","fn":"cmdEpisodicReindex"}
  - {"file":"src/mcp-server/index.ts"}
created_at: 2026-05-02T13:40:50.688Z
---

# FEAT — Persisted episodic atom-refs index

## User-facing behaviour

> Given a long-running orchestrator that calls `lookupByAtom` often,
> when the persisted `_atom_refs.jsonl` index is present,
> then GKS reads the index file directly to find matching refs
> instead of walking every session — the lookup primitive scales
> sub-linearly with session count.

> Given a developer who wants to rebuild a drifted index,
> when they run `gks episodic reindex`,
> then GKS walks every session and rewrites `_atom_refs.jsonl`
> atomically (write-then-rename).

> Given a fresh install without `_atom_refs.jsonl`,
> when an agent calls `lookupByAtom`,
> then GKS falls back to the existing live-scan implementation
> transparently — no migration required.

## Acceptance criteria

- [ ] **AC1**: `src/memory/episodic-atom-index.ts` exports
      `AtomRef`, `appendIndexRefs`, `loadIndexForAtom`,
      `reindexEpisodicAtoms`, and `expandCrosslinksToRefs` per
      BLUEPRINT.
- [ ] **AC2**: `EpisodicLayerV2.appendTurn` writes one AtomRef per
      `(predicate, target)` to `_atom_refs.jsonl` when the turn has
      crosslinks. Same for `appendEpisode`.
- [ ] **AC3**: `loadIndexForAtom(atomId, { predicates })` filters
      both by atom_id and optionally by predicate list.
- [ ] **AC4**: When `_atom_refs.jsonl` is absent, `loadIndexForAtom`
      returns `null`. `MemoryStore.lookupByAtom` falls back to live
      scan transparently.
- [ ] **AC5**: With the index present, `lookupByAtom` re-verifies
      each ref against the source episode/turn before returning
      (drops stale rows silently).
- [ ] **AC6**: `reindexEpisodicAtoms(layer)` walks every session and
      writes a fresh `_atom_refs.jsonl` (atomic via write-then-rename).
- [ ] **AC7**: Append is true append-only — sequential
      `appendIndexRefs` calls grow the file by exactly the expected
      lines; existing lines are byte-identical.
- [ ] **AC8**: `gks episodic reindex` CLI subcommand calls
      `reindexEpisodicAtoms` and prints `{refs, sessions}` counts.
- [ ] **AC9**: `gks_episodic_reindex` MCP tool exposes the same
      operation.
- [ ] **AC10**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests in `test/memory/episodic-atom-index.test.ts`.

## Out of scope

- Auto-reindex on detected drift. Manual `episodic reindex` is the
  recovery path; auto-detection adds complexity without clear demand.
- Sharding `_atom_refs.jsonl` by atom prefix. Single file is fine
  at the scale GKS targets.
- Bloom-filter pre-check on the source-of-truth side. Premature.
