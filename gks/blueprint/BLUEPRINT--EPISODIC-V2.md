---
id: BLUEPRINT--EPISODIC-V2
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Episodic memory v2
crosslinks: {"parent_adr":["ADR--EPISODIC-V2"],"parent_concept":["CONCEPT--EPISODIC-V2"]}
linked_symbols:
  - {"file":"src/memory/types.ts","fn":"EpisodicSession"}
  - {"file":"src/memory/types.ts","fn":"Episode"}
  - {"file":"src/memory/types.ts","fn":"Turn"}
  - {"file":"src/memory/episodic.ts","fn":"EpisodicLayer"}
  - {"file":"src/memory/episodic-v2.ts"}
  - {"file":"src/memory/session.ts","fn":"endSession"}
  - {"file":"src/memory/api.ts","fn":"reflect"}
created_at: 2026-05-02T05:57:35.832Z
---

# BLUEPRINT — Episodic memory v2

```yaml
metadata:
  title: "Episodic memory v2 — 3-document split + typed crosslinks"
  status: draft

architectural_pattern: |
  Three append-only documents per session. Episode/turn metadata stays
  in JSONL for streaming + per-line read; session header in single JSON
  blob. Typed crosslinks share predicate convention with atom layer.
  Schema-version dispatch keeps v1 readable forever.

data_logic: |
  Write path:
    1. session start → write session.json with schema_version: "2.0.0"
    2. each turn observed → append 1 line to turns.jsonl (carries
       episode_id; episode_id auto-allocated if not provided by
       caller)
    3. context shift / explicit episode boundary → append 1 line to
       episodes.jsonl
    4. session end → finalise session.json (ended_at, summary,
       outcomes, tags), update _index.jsonl

  Read path:
    1. session_id known → open <session_id>/session.json (1 file read)
    2. if v1 (no schema_version field) → delegate to EpisodicLayer v1
       parser
    3. if v2 → enumerate episodes.jsonl (filter / paginate)
    4. for each episode of interest → grep turns.jsonl by episode_id

  Crosslinks:
    - validateLinks() walks crosslinks on episode + turn level the
      same way it walks atom crosslinks. Core predicates validated;
      others tolerated.
    - lookupBySymbol-style reverse index can extend to episode
      crosslinks in a follow-up (not in scope for this BLUEPRINT).

  Migration:
    - No automatic migration of existing v1 files.
    - `gks episodic migrate <session_id>` re-emits v1 → v2 (best-effort
      mapping: full v1 summary becomes a single Episode with one Turn
      per parsed trace step).

geography:
  - "src/memory/types.ts"                   # add EpisodicSession/Episode/Turn types
  - "src/memory/episodic.ts"                # add v2 dispatch to existing EpisodicLayer
  - "src/memory/episodic-v2.ts"             # NEW: v2 read/write
  - "src/memory/session.ts"                 # endSession writes v2 by default
  - "src/memory/api.ts"                     # reflect() emits v2 EpisodicSession shape
  - "test/memory/episodic-v2.test.ts"       # NEW
  - "test/memory/session.test.ts"           # update for v2 default

api_contracts:
  - name: "EpisodicSession"
    file: "src/memory/types.ts"
    shape: |
      interface EpisodicSession {
        schema_version: string         // "2.0.0"
        system: string                 // free-form orchestrator id
        user_id?: string
        instance_id?: string
        session_id: string
        started_at: string             // ISO-8601
        ended_at?: string              // unset until endSession
        namespace?: Namespace          // map to GKS Namespace
        summary?: string               // optional rollup
        outcomes?: string[]
        tags?: string[]
      }

  - name: "Episode"
    file: "src/memory/types.ts"
    shape: |
      interface Episode {
        episode_id: string
        episode_type: 'interaction' | 'observation' | 'system_event'
        episode_tag?: string[]
        situation_context?: {
          context_id?: string
          interaction_mode?: 'casual' | 'discussion' | 'deep_discussion' | 'crisis'
          stakes_level?: 'low' | 'medium' | 'high'
          time_pressure?: 'low' | 'medium' | 'high'
        }
        crosslinks?: EpisodicCrosslinks
        turn_count: number             // denormalised
        first_turn_id?: string
        last_turn_id?: string
        started_at?: string
        ended_at?: string
        provenance?: {
          written_by?: string
          llm_contribution?: string[]
          authoritative_fields?: string[]
        }
      }

  - name: "Turn"
    file: "src/memory/types.ts"
    shape: |
      interface Turn {
        turn_id: string
        episode_id: string             // FK to Episode.episode_id
        t: string                      // ISO-8601 timestamp
        speaker: string                // free-form ('user', 'agent', 'tool', ...)
        raw_text?: string
        text_excerpt?: string
        summary?: string
        epistemic_mode?: 'reflect' | 'inquire' | 'explain' | 'explore'
        semantic_frames?: string[]
        salience_anchor?: {
          phrase: string
          resonance_impact: number     // 0..1
          authority?: string
        }
        action?: {
          action_type?: string
          artifacts?: string[]
          tools_used?: string[]
        }
        crosslinks?: EpisodicCrosslinks
      }

  - name: "EpisodicCrosslinks"
    file: "src/memory/types.ts"
    shape: |
      // Predicate keys map to AtomicId arrays. Core predicates
      // (CORE_EPISODIC_PREDICATES) are validated by validate-links;
      // additional predicates pass through untouched.
      type EpisodicCrosslinks = Record<string, string[]>

      const CORE_EPISODIC_PREDICATES = [
        'discusses', 'implements', 'contradicts',
        'supports', 'derived_from', 'references',
      ] as const

  - name: "EpisodicLayerV2"
    file: "src/memory/episodic-v2.ts"
    shape: |
      class EpisodicLayerV2 {
        readSession(sessionId: string): Promise<EpisodicSession | null>
        listEpisodes(sessionId: string): Promise<Episode[]>
        listTurns(sessionId: string, episodeId?: string): Promise<Turn[]>
        appendTurn(sessionId: string, turn: Omit<Turn, 'turn_id'> & { turn_id?: string }): Promise<Turn>
        appendEpisode(sessionId: string, episode: Omit<Episode, 'episode_id' | 'turn_count'> & { episode_id?: string }): Promise<Episode>
        writeSession(session: EpisodicSession): Promise<void>
        finaliseSession(sessionId: string, patch: Partial<EpisodicSession>): Promise<void>
      }

verification_plan:
  - id: V1-three-doc-roundtrip
    description: |
      writeSession + appendEpisode + appendTurn round-trip through disk.
      readSession returns the EpisodicSession; listEpisodes returns
      the appended episodes; listTurns(episodeId) returns the matching
      turns in append order.
  - id: V2-fk-integrity
    description: |
      A turn appended with episode_id="E-X" appears in
      listTurns(sessionId, "E-X") and not in listTurns for any other
      episode. Cross-episode bleed = bug.
  - id: V3-jsonl-append-only
    description: |
      Two sequential appendTurn() calls grow turns.jsonl by exactly
      two lines. Existing lines are byte-identical. (Open the file in
      append mode; never rewrite.)
  - id: V4-v1-coexistence
    description: |
      Reading a session_id whose session.json has no schema_version
      (or whose path is the v1 markdown layout) returns the v1
      EpisodicMemory shape via the legacy parser. Same MemoryStore
      handles both transparently.
  - id: V5-typed-crosslinks-validated
    description: |
      validateLinks runs over an EpisodicSession with episode + turn
      crosslinks pointing at non-existent atom IDs and reports
      broken edges. Unknown predicate keys (e.g. "inspired_by") pass
      through with a warning, not an error.
  - id: V6-denormalised-counts-stay-fresh
    description: |
      After appendTurn, the matching Episode's turn_count, last_turn_id
      reflect the new turn. (Updates the episode's denormalised counts
      via a single rewrite of episodes.jsonl — acceptable because
      episode count ≪ turn count.)
  - id: V7-index-updates-on-finalise
    description: |
      finaliseSession() updates _index.jsonl with the session's
      episode_count + turn_count + summary. _index.jsonl never
      contains duplicate session_id rows.

implementation_steps:
  - 1. Land types: EpisodicSession, Episode, Turn, EpisodicCrosslinks,
       CORE_EPISODIC_PREDICATES in src/memory/types.ts.
  - 2. Build src/memory/episodic-v2.ts with read/write helpers + path
       layout helpers.
  - 3. Add v2 dispatch inside EpisodicLayer (read returns v1 OR v2
       depending on disk shape).
  - 4. Update session.ts endSession to write v2 (with v1 opt-out flag
       for tooling that hasn't migrated).
  - 5. Update reflect() / consolidator output mapping to emit v2 shape.
  - 6. Tests V1-V7. Bump manifest.schema_version (minor — additive).
  - 7. Document in docs/ARCHITECTURE.md (4-layer model: episodic
       gets richer).
  - 8. CLI: `gks episodic show <session-id>` + `gks episodic migrate
       <session-id>` follow-ups (out of scope here).
```
