---
id: BLUEPRINT--EPISODIC-ATOM-INDEX
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Episodic atom-refs index
crosslinks: {"parent_adr":["ADR--EPISODIC-ATOM-INDEX"],"parent_concept":["CONCEPT--EPISODIC-ATOM-INDEX"]}
linked_symbols:
  - {"file":"src/memory/episodic-atom-index.ts","fn":"appendIndexRefs"}
  - {"file":"src/memory/episodic-atom-index.ts","fn":"loadIndexForAtom"}
  - {"file":"src/memory/episodic-atom-index.ts","fn":"reindexEpisodicAtoms"}
  - {"file":"src/memory/episodic-v2.ts","fn":"EpisodicLayerV2.appendTurn"}
  - {"file":"src/memory/episodic-v2.ts","fn":"EpisodicLayerV2.appendEpisode"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.lookupByAtom"}
  - {"file":"bin/gks.ts","fn":"cmdEpisodicReindex"}
created_at: 2026-05-02T13:40:49.157Z
---

# BLUEPRINT — Episodic atom-refs index

```yaml
metadata:
  title: "Persisted reverse atom→episode/turn index"
  status: draft

architectural_pattern: |
  New module `episodic-atom-index.ts`: appendIndexRefs writes one
  AtomRef per (atom, predicate) at write time; loadIndexForAtom
  greps the index for a target atom. EpisodicLayerV2.appendTurn /
  appendEpisode call appendIndexRefs after writing the source row.
  MemoryStore.lookupByAtom prefers the index when present, falls
  back to live scan when absent.

data_logic: |
  AtomRef shape:
    { atom_id, session_id, episode_id, turn_id?, predicate, t }

  appendIndexRefs(layer, source, refs):
    Open <episodicDir>/_atom_refs.jsonl in append mode.
    For each ref: write JSON.stringify(ref) + '\n'.

  loadIndexForAtom(layer, atomId, opts):
    Read _atom_refs.jsonl, filter rows where atom_id matches,
    optionally filter by predicate. Returns array of AtomRef.

  reindexEpisodicAtoms(layer):
    Walk every session.
    For each, walk episodes.jsonl + turns.jsonl, regenerate refs.
    Write to <episodicDir>/_atom_refs.jsonl.tmp, rename atomic.

  scanEpisodicForAtom (updated):
    1. Try loadIndexForAtom — if returns non-empty, use those refs
       to seek directly to the matching episodes/turns and
       re-verify the crosslinks (drop stale rows).
    2. If index missing (no file), fall back to existing
       full-store walk.

  EpisodicLayerV2.appendTurn (updated):
    ... existing append logic ...
    if (turn.crosslinks):
      const refs = expandCrosslinksToRefs(turn.crosslinks, sessionId, turn)
      await appendIndexRefs(this.episodicDir, refs)

  EpisodicLayerV2.appendEpisode (updated):
    ... existing append logic ...
    if (episode.crosslinks):
      const refs = expandCrosslinksToRefs(episode.crosslinks, sessionId, episode)
      await appendIndexRefs(this.episodicDir, refs)

  expandCrosslinksToRefs(crosslinks, sessionId, source):
    return Object.entries(crosslinks).flatMap(([predicate, targets]) =>
      targets.map(atom_id => ({
        atom_id, session_id: sessionId,
        episode_id: source.episode_id ?? source.episode_id,
        ...(source.turn_id ? { turn_id: source.turn_id } : {}),
        predicate,
        t: source.t ?? source.started_at ?? new Date().toISOString(),
      }))
    )

geography:
  - "src/memory/episodic-atom-index.ts"     # NEW: index helpers + AtomRef
  - "src/memory/episodic-v2.ts"              # appendTurn/appendEpisode call appendIndexRefs
  - "src/memory/index.ts"                    # public re-exports
  - "bin/gks.ts"                             # `gks episodic reindex` CLI
  - "src/mcp-server/index.ts"                # gks_episodic_reindex MCP tool
  - "test/memory/episodic-atom-index.test.ts" # NEW

api_contracts:
  - name: "AtomRef"
    file: "src/memory/episodic-atom-index.ts"
    shape: |
      interface AtomRef {
        atom_id: string
        session_id: string
        episode_id: string
        turn_id?: string         // omitted for episode-level refs
        predicate: string
        t: string                // turn or episode timestamp
      }

  - name: "appendIndexRefs"
    file: "src/memory/episodic-atom-index.ts"
    shape: |
      function appendIndexRefs(
        episodicDir: string,
        refs: AtomRef[],
      ): Promise<void>

  - name: "loadIndexForAtom"
    file: "src/memory/episodic-atom-index.ts"
    shape: |
      function loadIndexForAtom(
        episodicDir: string,
        atomId: string,
        opts?: { predicates?: string[] },
      ): Promise<AtomRef[] | null>   // null = no index file present

  - name: "reindexEpisodicAtoms"
    file: "src/memory/episodic-atom-index.ts"
    shape: |
      function reindexEpisodicAtoms(layer: EpisodicLayerV2): Promise<{ refs: number; sessions: number }>

verification_plan:
  - id: V1-self-builds-on-write
    description: |
      appendTurn with crosslinks={discusses:['FEAT--X']} → one
      AtomRef appended to _atom_refs.jsonl. Two predicates → two refs.
  - id: V2-load-filters-by-atom
    description: |
      loadIndexForAtom('FEAT--X') returns refs where atom_id matches;
      excludes refs for other atoms.
  - id: V3-load-filters-by-predicate
    description: |
      loadIndexForAtom('FEAT--X', {predicates: ['implements']})
      returns only implements rows.
  - id: V4-no-index-returns-null
    description: |
      Fresh dir without _atom_refs.jsonl → loadIndexForAtom returns
      null. lookupByAtom falls through to live scan.
  - id: V5-reindex-rebuilds-from-source
    description: |
      Drop _atom_refs.jsonl, run reindexEpisodicAtoms. Resulting
      index has the same refs as the originally-written ones.
  - id: V6-lookupByAtom-uses-index
    description: |
      With index present, lookupByAtom returns the same result as
      live scan (verified by comparing to a no-index baseline).
  - id: V7-append-only-invariant
    description: |
      Two sequential appendTurn calls with crosslinks → index file
      grows by exactly the expected number of new lines. Existing
      lines are byte-identical.

implementation_steps:
  - 1. Build src/memory/episodic-atom-index.ts: types,
       appendIndexRefs, loadIndexForAtom, reindexEpisodicAtoms,
       expandCrosslinksToRefs.
  - 2. Wire appendTurn / appendEpisode in episodic-v2.ts to call
       appendIndexRefs when crosslinks present.
  - 3. Update scanEpisodicForAtom to consult the index first
       (re-verify each ref against the source row).
  - 4. CLI: `gks episodic reindex` subcommand.
  - 5. MCP: `gks_episodic_reindex` tool.
  - 6. Public re-exports.
  - 7. Tests V1-V7.
```
