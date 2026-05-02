---
id: ADR--EPISODIC-V2
phase: 2
type: adr
status: stable
vault_id: default
title: "ADR — Episodic memory v2: 3-document split + typed crosslinks"
crosslinks: {"parent_concept":["CONCEPT--EPISODIC-V2"],"references":["ADR--FLAT-ATOM-LAYOUT","ADR--EXTENDED-TAXONOMY","ADR--SUMMARY-TLDR"]}
created_at: 2026-05-02T05:57:34.300Z
---

# ADR — Episodic memory v2: 3-document split + typed crosslinks

## Context

Per [[CONCEPT--EPISODIC-V2]], the v1 schema (one summary per session)
is too coarse for episode-level recall and per-turn cognitive metadata.
EVA's MSP-v9.1 schema is the right shape but coupled to EVA's cognitive
paradigm (ESS, RMS, EVA matrix). We need a GKS-native version.

The questions for this ADR are:
1. **What gets cut from EVA-Episodic-Memory-v2?**
2. **How is the schema split across files?**
3. **What's the link convention?**
4. **How does v1 coexist with v2?**

## Decision

### 1. Scope cuts (vs EVA original)

Stripped from the EVA schema:
- `emotive_snapshot` (entire block: indexed_state, eva_matrix, qualia, reflex)
- `affective_inference` on each turn
- `crosslinks.ess_refs` — Emotional State System (EVA-specific)
- `crosslinks.eva_matrix_refs` — EVA matrix snapshots (EVA-specific)
- `crosslinks.rms_refs` — Resonance Memory System (EVA-specific)
- Hardcoded enums: `system: "EVA"`, `speaker: ["user", "eva"]`, `authority: "MSP"` → all become free strings

GKS is a storage engine; affect/emotion/resonance are orchestrator
concerns ([[ADR--FLAT-ATOM-LAYOUT]] philosophy). Keeping them out
prevents this schema from becoming "EVA-shaped" — orchestrators that
need richer state add their own sidecar files in `.brain/<ns>/<their-namespace>/`.

### 2. File split — three documents per session

```
.brain/<ns>/episodic/
  ├── _index.jsonl                              ← session-level index (1 line/session)
  └── <session_id>/
      ├── session.json                          ← top-level metadata
      ├── episodes.jsonl                        ← append-only, 1 line/episode
      └── turns.jsonl                           ← append-only, 1 line/turn (FK episode_id)
```

Rationale per file:
- `session.json` changes once (at endSession) → small JSON object
- `episodes.jsonl` grows on context shift → JSONL append-only
- `turns.jsonl` grows on every message → highest volume → JSONL append-only

Three rates of change → three files. Matches GKS's existing
`atomic_index.jsonl` / vector store / audit log conventions.

### 3. Link convention — turn → episode (FK), typed predicates

**Connection direction:** `turn.episode_id` (FK) is the single source
of truth for episode↔turn relationship. Episode metadata carries
denormalized `turn_count` / `first_turn_id` / `last_turn_id` for
fast-path reads, but the canonical edge lives on the turn.

**Crosslinks at episode + turn level use predicate keys**, matching the
convention atom crosslinks already use today:

```jsonc
"crosslinks": {
  "discusses":   ["FEAT--FOO"],
  "implements":  ["FEAT--BAR"],
  "contradicts": ["INSIGHT--OLD"],
  "references":  ["CONCEPT--MEMORY-STORE"],
  "<custom>":    ["..."]                        // open-set predicates allowed
}
```

GKS validates only **core predicates** (the same set atom crosslinks
use); other predicates pass through untouched. Predicate semantics
(what `contradicts` means in agent reasoning) belongs to the
orchestrator, not GKS.

### 4. Coexistence with v1

- Add `schema_version: "2.0.0"` to `session.json`; v1 files lack the
  field (treated as v1).
- `EpisodicLayer.read(sessionId)` detects version and dispatches.
- New writes (`endSession`) emit v2 by default; opt back to v1 via
  `endSession({ schemaVersion: '1' })` for tooling that hasn't migrated.
- No automatic migration of existing v1 files. Tooling is provided to
  re-emit v1→v2 on demand (`gks episodic migrate <session-id>`)
  but never run implicitly.

## Consequences

**Positive:**
- Episode-grain recall + per-turn cognitive metadata available without
  re-reading raw text.
- Append-only writes — multi-process / streaming agents safe.
- Typed crosslinks make the session graph traversable by the same
  primitives that already walk atom graphs (`verify-flow`,
  `summarizeCommunity`, `lookupBySymbol`).
- GKS stays storage-only; no cognitive paradigm coupling.

**Negative:**
- Breaking shape change for direct `EpisodicMemory` consumers (none
  in the public API yet — the field is exposed only through
  `MemoryStore.writeEpisodic` / `EpisodicLayer.read`). Compatibility
  layer reads v1 transparently.
- Three files per session vs one. Mitigated by directory-per-session
  layout + `_index.jsonl` for fast session enumeration.
- Predicate open-set means typo predicates land silently. Mitigated
  by `validate-links` warning (not erroring) on unknown predicates,
  and by `gks community summarize`-style tooling that surfaces edge
  type usage.

**Schema impact:**
- New types in `src/memory/types.ts`: `EpisodicSession`, `Episode`,
  `Turn`, `EpisodicCrosslinks`, `CORE_EPISODIC_PREDICATES`.
- `EpisodicLayer` gains a v1/v2 dispatch layer.
- `ReflectResult` / `ConsolidationOutput` shapes unchanged externally;
  internal mapping to v2 happens in the consolidator.

## Alternatives considered

1. **Stay at v1 + extend EpisodicMemory in place.** — *rejected.*
   Adding episode/turn arrays inside the v1 markdown turns it into a
   mega-document with the same write-amplification + append-unfriendly
   problems we're trying to fix.

2. **Adopt EVA-Episodic-Memory-v2 verbatim.** — *rejected.* Pulls in
   ESS / RMS / EVA matrix concepts that violate
   [[ADR--FLAT-ATOM-LAYOUT]] philosophy and would force GKS consumers
   to reason about EVA's cognitive paradigm.

3. **Closed-set typed predicates only.** — *rejected.* Forcing every
   crosslink type into a known enum kills extensibility. Hybrid (core
   set validated, extensions tolerated) matches how atom crosslinks
   already work.

4. **Edge object form** (`{target, type, since, strength}` instead of
   `{type: [target, target]}`). — *deferred.* Richer but doubles the
   serialised size. The current shape leaves room for an `_attrs`
   sidecar later if attributes become necessary.

5. **Single .jsonl with a `kind` discriminator** (session/episode/turn
   in one stream). — *rejected.* Session metadata changes once;
   forcing it into a streaming file complicates the read path. Three
   files lets each grow at its own rate.
