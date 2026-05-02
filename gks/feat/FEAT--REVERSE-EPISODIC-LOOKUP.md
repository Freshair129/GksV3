---
id: FEAT--REVERSE-EPISODIC-LOOKUP
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Reverse episodic lookup
crosslinks: {"parent_concept":["CONCEPT--REVERSE-EPISODIC-LOOKUP"],"parent_adr":["ADR--REVERSE-EPISODIC-LOOKUP"],"parent_blueprint":["BLUEPRINT--REVERSE-EPISODIC-LOOKUP"]}
linked_symbols:
  - {"file":"src/memory/episodic-v2.ts","fn":"scanEpisodicForAtom"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.lookupByAtom"}
  - {"file":"bin/gks.ts","fn":"cmdEpisodicLookup"}
  - {"file":"src/mcp-server/index.ts","fn":"gks_lookup_by_atom"}
created_at: 2026-05-02T09:36:42.546Z
---

# FEAT — Reverse episodic lookup

## User-facing behaviour

> Given a developer who wants every conversation that referenced a
> specific atom,
> when they call `store.lookupByAtom('FEAT--SUMMARY-TLDR')`,
> then GKS returns episodes + turns whose typed crosslinks include
> that id, sorted chronologically (turns by `t`, episodes by
> session/episode id).

> Given the same developer wanting only "implements" references,
> when they call `store.lookupByAtom('FEAT--FOO', { predicates: ['implements'] })`,
> then `discusses` / `references` / etc. matches are skipped; only
> `implements` matches land in the result.

> Given the CLI: `gks episodic lookup FEAT--BAR`,
> when run on a workspace with v2 episodic data,
> then GKS prints a chronological list of references with the matching
> predicate key on each row.

## Acceptance criteria

- [ ] **AC1**: `src/memory/episodic-v2.ts` exports
      `scanEpisodicForAtom(layer, atomId, opts?)` returning
      `LookupByAtomResult` per BLUEPRINT.
- [ ] **AC2**: `MemoryStore.lookupByAtom(atomId, opts?)` is defined
      and exported from `src/memory/index.ts`.
- [ ] **AC3**: Result `episodes[]` is sorted by `(session_id, episode_id)`;
      `turns[]` is sorted by `t` ascending (chronological).
- [ ] **AC4**: An entry citing the atom under multiple predicates
      lands once with `predicates[]` deduplicated (no duplicate
      EpisodeRef/TurnRef rows for the same id).
- [ ] **AC5**: `opts.predicates` filter restricts the scan; entries
      whose only matches are outside the filter are skipped.
- [ ] **AC6**: `result.scanned` reflects actual session/episode/turn
      counts walked (useful for debugging / cost estimation).
- [ ] **AC7**: Empty / nonexistent atom id → empty episodes + turns
      arrays (not an error).
- [ ] **AC8**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests in `test/memory/reverse-episodic.test.ts`.
- [ ] **AC9**: `gks episodic lookup ATOM--ID [--predicates=a,b]`
      CLI subcommand produces a chronological listing; `--json`
      emits the raw `LookupByAtomResult`.
- [ ] **AC10**: `gks_lookup_by_atom` MCP tool with the same input
      surface (`atomId`, optional `predicates[]`).

## Out of scope

- Persisted reverse index (cache tier). MVP is live scan; pair with
  PERSISTED-COMMUNITY-SUMMARIES if read amplification justifies a
  similar disk-tier for episodic refs.
- Pagination — typical result sets are small; revisit when
  empirical data shows otherwise.
- Cross-namespace scan (stays within configured `defaultNamespace`).
- Querying by file/symbol path (already covered by `lookupBySymbol`
  for atoms; episodes don't carry `linked_symbols` today).
