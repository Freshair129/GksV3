---
id: CONCEPT--REVERSE-EPISODIC-LOOKUP
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Reverse lookup for episodic crosslinks
crosslinks: {"references":["CONCEPT--MEMORY-STORE"]}
created_at: 2026-05-02T09:36:38.821Z
---

# CONCEPT — Reverse lookup for episodic crosslinks

## Problem

ADR-010 introduced `lookupBySymbol(file:fn)` — a reverse-citation
primitive that lets agents ask "which atoms cite this code path?".
EPISODIC-V2 added typed crosslinks at the episode + turn level
(`crosslinks: { discusses: [...], implements: [...], references: [...] }`),
but there's no symmetric primitive for asking the reverse:
"which past episodes / turns cited this atom?"

Without it, an agent that wants to refresh on prior conversations
about `FEAT--SUMMARY-TLDR` has to:
1. Walk every session in `_index.jsonl`
2. Open each session's `episodes.jsonl`
3. Filter episodes whose crosslinks include the target id
4. Open `turns.jsonl` for each matching session
5. Filter turns whose crosslinks include the target id

That's O(sessions × episodes + sessions × turns) per query — manageable
at small scale, but agents will ask this question often and the
all-sessions scan is wasteful.

## Hypothesis

If `MemoryStore.lookupByAtom(atomId, opts?)` returns
`{ episodes: EpisodeRef[], turns: TurnRef[] }` by scanning across
all v2 sessions and their crosslinks, then:

- Agents get conversation continuity: "we discussed this atom three
  times before, here are the contexts."
- Knowledge-base auditing: "where has FEAT--FOO been referenced?"
- Backwards-traceability for the doc-to-code chain: code-level
  crosslink already supported via `lookupBySymbol`; this adds the
  conversation-level crosslink.

The cost is O(N) over all turns, but the per-session JSONL files are
small + cache-friendly. For larger scale, the same caller can
later switch to a persisted reverse index — out of scope for the
MVP.
