---
id: BLUEPRINT--REVERSE-EPISODIC-LOOKUP
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Reverse episodic lookup
crosslinks: {"parent_adr":["ADR--REVERSE-EPISODIC-LOOKUP"],"parent_concept":["CONCEPT--REVERSE-EPISODIC-LOOKUP"]}
linked_symbols:
  - {"file":"src/memory/episodic-v2.ts","fn":"scanEpisodicForAtom"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.lookupByAtom"}
  - {"file":"src/mcp-server/index.ts","fn":"gks_lookup_by_atom"}
  - {"file":"bin/gks.ts","fn":"cmdEpisodicLookup"}
created_at: 2026-05-02T09:36:41.340Z
---

# BLUEPRINT — Reverse episodic lookup

```yaml
metadata:
  title: "Reverse episodic lookup (lookupByAtom)"
  status: draft

architectural_pattern: |
  Live-scan primitive over the v2 episodic store. Walks _index.jsonl,
  loads per-session episodes.jsonl + turns.jsonl, filters entries
  whose typed crosslinks reference the target atom, returns a
  unified result. No schema change.

data_logic: |
  scanEpisodicForAtom(layer, atomId, opts):
    sessions = layer.listSessions()    # _index.jsonl rows
    episodeRefs = []
    turnRefs = []
    counts = { sessions: sessions.length, episodes: 0, turns: 0 }

    for s in sessions:
      eps = layer.listEpisodes(s.session_id)
      counts.episodes += eps.length
      for ep in eps:
        const preds = matchedPredicates(ep.crosslinks, atomId, opts.predicates)
        if preds.length > 0:
          episodeRefs.push(buildEpisodeRef(s.session_id, ep, preds))

      turns = layer.listTurns(s.session_id)
      counts.turns += turns.length
      for t in turns:
        const preds = matchedPredicates(t.crosslinks, atomId, opts.predicates)
        if preds.length > 0:
          turnRefs.push(buildTurnRef(s.session_id, t, preds))

    sort episodeRefs by (session_id, episode_id)
    sort turnRefs by t  (chronological)

    return { atomId, episodes, turns, scanned: counts }

  matchedPredicates(crosslinks, atomId, predicateFilter):
    if !crosslinks: return []
    const matches = []
    for [pred, targets] in Object.entries(crosslinks):
      if predicateFilter && !predicateFilter.includes(pred): continue
      if !targets.includes(atomId): continue
      matches.push(pred)
    return [...new Set(matches)]

geography:
  - "src/memory/episodic-v2.ts"           # scanEpisodicForAtom + types
  - "src/memory/index.ts"                 # MemoryStore.lookupByAtom + exports
  - "src/mcp-server/index.ts"             # gks_lookup_by_atom MCP tool
  - "bin/gks.ts"                          # `gks episodic lookup ATOM--ID`
  - "test/memory/reverse-episodic.test.ts" # NEW

api_contracts:
  - name: "EpisodeRef + TurnRef + LookupByAtomResult"
    file: "src/memory/episodic-v2.ts"
    shape: |
      interface EpisodeRef {
        session_id: string
        episode_id: string
        predicates: string[]
        episode_type: Episode['episode_type']
        episode_tag?: string[]
      }
      interface TurnRef {
        session_id: string
        episode_id: string
        turn_id: string
        predicates: string[]
        speaker: string
        t: string
      }
      interface LookupByAtomResult {
        atomId: string
        episodes: EpisodeRef[]
        turns: TurnRef[]
        scanned: { sessions: number; episodes: number; turns: number }
      }

  - name: "scanEpisodicForAtom"
    file: "src/memory/episodic-v2.ts"
    shape: |
      function scanEpisodicForAtom(
        layer: EpisodicLayerV2,
        atomId: string,
        opts?: { predicates?: string[] },
      ): Promise<LookupByAtomResult>

  - name: "MemoryStore.lookupByAtom"
    file: "src/memory/index.ts"
    shape: |
      class MemoryStore {
        lookupByAtom(atomId: string, opts?: { predicates?: string[] }): Promise<LookupByAtomResult>
      }

verification_plan:
  - id: V1-empty-store
    description: |
      No v2 sessions on disk → result has empty episodes[], turns[],
      scanned.sessions=0. Does not throw.
  - id: V2-episode-match
    description: |
      A session whose Episode.crosslinks.discusses=['ATOM--X'] →
      result.episodes has 1 entry with predicates=['discusses'].
  - id: V3-turn-match
    description: |
      A turn whose crosslinks.implements=['ATOM--X'] →
      result.turns has 1 entry with predicates=['implements'].
  - id: V4-multi-predicate-dedupe
    description: |
      An entry whose crosslinks have ATOM--X under TWO predicate keys
      → result has predicates=['discusses', 'implements'] (no duplicate
      EpisodeRef/TurnRef rows).
  - id: V5-predicate-filter
    description: |
      With opts.predicates=['implements'], only `implements` matches
      contribute. `discusses`-only matches are skipped.
  - id: V6-cross-session
    description: |
      Two sessions both reference ATOM--X. Result merges across
      sessions, sorted by session_id (episodes) and t (turns).
  - id: V7-no-match
    description: |
      Atom is never referenced → empty episodes/turns but
      scanned reflects the actual count of sessions/episodes/turns
      walked.

implementation_steps:
  - 1. Add EpisodeRef, TurnRef, LookupByAtomResult types to
       src/memory/episodic-v2.ts (or types.ts — local module is fine
       since they live close to the scan function).
  - 2. Implement scanEpisodicForAtom in episodic-v2.ts.
  - 3. Wire MemoryStore.lookupByAtom (async wrapper).
  - 4. Public exports.
  - 5. CLI: `gks episodic lookup <ATOM--ID> [--predicates=a,b]`.
  - 6. MCP: `gks_lookup_by_atom`.
  - 7. Tests V1-V7 with hand-built fixtures (in-memory v2 layer
       writing to mkdtemp).
```
