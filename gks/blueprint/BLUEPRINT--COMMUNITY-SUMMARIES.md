---
id: BLUEPRINT--COMMUNITY-SUMMARIES
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Higher-order summaries over atom communities
crosslinks: {"parent_adr":["ADR--COMMUNITY-SUMMARIES"],"parent_concept":["CONCEPT--COMMUNITY-SUMMARIES"]}
linked_symbols:
  - {"file":"src/memory/community.ts"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.summarizeCommunity"}
  - {"file":"src/memory/tldr.ts"}
created_at: 2026-05-01T12:26:06.308Z
---

# BLUEPRINT — Higher-order summaries over atom communities

```yaml
metadata:
  title: "Higher-order summaries over atom communities"
  status: draft

architectural_pattern: |
  Pure read-side primitive: BFS-walk the structured crosslinks from a
  seed, gather member TLDRs (or bodies), feed to an LLM, return one
  narrative + the member id list. In-memory LRU cache keyed by the
  sorted member-id tuple. No persistence; no schema change.

data_logic: |
  Inputs:
    - seed: string | string[]
    - hops: number (default 1, cap 3)
    - edges: structural crosslink keys (default: all)
    - includeBodies: boolean (default false → use summary_tldr)
    - maxMembers: number (default 30)
    - generator: TldrGenerator (default: heuristicTldrGenerator())

  Step 1 — Walk:
    members = bfs(seed, hops, edges) using AtomicLayer.getEntry().
    Cap at maxMembers; sort by phase ascending then id.

  Step 2 — Build prompt:
    For each member, fetch summary_tldr; fall back to body if
    includeBodies=true OR no TLDR present. Prepend "Atom: <id> —
    <title>\n<text>\n\n".

  Step 3 — Cache check:
    key = `${sortedMemberIds.join(',')}|${generator.name}|${includeBodies}`
    Return cached result if present (mark cached: true).

  Step 4 — Synthesise:
    Call generator.summarize(combinedText, { maxTokens: 500, type: 'community' }).
    Heuristic fallback: concatenate first 1-2 sentences of each TLDR
    as a fixed bulleted list (deterministic, zero-LLM-cost).

  Step 5 — Return:
    { members, summary, truncated, cached, inputTokensEstimate }

geography:
  - "src/memory/community.ts"      # NEW: walk + summariser
  - "src/memory/index.ts"          # add summarizeCommunity to MemoryStore
  - "src/memory/tldr.ts"           # may extend TldrGenerator with community context
  - "test/memory/community.test.ts" # NEW

api_contracts:
  - name: "summarizeCommunity"
    file: "src/memory/index.ts"
    shape: |
      class MemoryStore {
        summarizeCommunity(req: CommunityRequest): Promise<CommunityResult>
      }

      interface CommunityRequest {
        seed: string | string[]
        hops?: number             // 1..3, default 1
        edges?: Array<keyof Crosslinks>
        includeBodies?: boolean   // default false
        maxMembers?: number       // default 30
        generator?: TldrGenerator
      }

      interface CommunityResult {
        members: string[]         // sorted (phase asc, id asc)
        summary: string
        truncated: boolean
        cached: boolean
        inputTokensEstimate: number
      }

  - name: "walkCommunity"
    file: "src/memory/community.ts"
    shape: |
      function walkCommunity(
        atomic: AtomicLayer,
        seed: string | string[],
        opts: { hops: number; edges: string[]; maxMembers: number },
      ): { members: string[]; truncated: boolean }

verification_plan:
  - id: V1-walk-determinism
    description: |
      walkCommunity(seed, hops=1, edges=['references']) returns the
      same member list across runs (sorted by phase asc, id asc).
  - id: V2-bfs-bounded
    description: |
      walkCommunity(seed, hops=2) does NOT return atoms reachable only
      at depth 3. Add fixture with a 4-level chain to assert bound.
  - id: V3-maxMembers-cap
    description: |
      With maxMembers=2 in a graph that would expand to 5, the result
      includes exactly 2 members and truncated=true.
  - id: V4-tldr-vs-body
    description: |
      includeBodies=false uses summary_tldr when present; falls back
      to body when summary_tldr absent. inputTokensEstimate reflects
      the choice.
  - id: V5-cache
    description: |
      Two consecutive summarizeCommunity() calls with identical args
      hit the LRU cache (cached=true on the second). Different args
      produce a fresh call.
  - id: V6-heuristic-fallback
    description: |
      With no LLM client (heuristic generator), the summary is a
      bullet list of TLDR first sentences — deterministic, valid
      markdown.
  - id: V7-llm-injection
    description: |
      With createLlmTldrGenerator + a mock LlmClient that returns
      fixed text, the summary equals the mock output. Confirms the
      generator interface plumbs through.

implementation_steps:
  - 1. Build src/memory/community.ts: walkCommunity (BFS, dedupe,
       phase-sort, cap) + buildCommunityPrompt + LRU cache.
  - 2. Add MemoryStore.summarizeCommunity that delegates to (1) and
       reuses the existing TldrGenerator interface for synthesis.
  - 3. Tests for V1-V7.
  - 4. Public exports in src/memory/index.ts.
  - 5. Update examples/quickstart-local.ts with a community demo.
  - 6. Document in docs/WORKFLOW.md.
```
