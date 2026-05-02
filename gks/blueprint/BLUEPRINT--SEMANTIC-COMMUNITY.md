---
id: BLUEPRINT--SEMANTIC-COMMUNITY
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Semantic neighbourhood mode
crosslinks: {"parent_adr":["ADR--SEMANTIC-COMMUNITY"],"parent_concept":["CONCEPT--SEMANTIC-COMMUNITY"]}
linked_symbols:
  - {"file":"src/memory/community.ts","fn":"summarizeCommunity"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.summarizeCommunity"}
created_at: 2026-05-02T06:15:10.596Z
---

# BLUEPRINT — Semantic neighbourhood mode

```yaml
metadata:
  title: "Semantic mode for summarizeCommunity"
  status: draft

architectural_pattern: |
  Add `mode: 'structural' | 'semantic' | 'hybrid'` to CommunityRequest.
  Semantic membership = embed seed → vector top-K nearest → filter by
  cosine threshold. Hybrid = structural ∪ semantic, deduped, sorted.

data_logic: |
  function summarizeCommunity(deps, req):
    members_struct = mode in ['structural','hybrid'] ? walkCommunity(...) : []
    members_semantic = mode in ['semantic','hybrid'] ? semanticWalk(...) : []
    members = dedupe(members_struct + members_semantic), sort by phase asc, id asc
    breakdown = computeBreakdown(struct, semantic)
    [...rest unchanged: build prompt, synthesise, cache, return]

  function semanticWalk(seedAtoms, vectorBackend, embedder, threshold, topK):
    text = seed.summary_tldr || seed.title || seed.id
    queryVec = await embedder.embed(text)
    hits = await vectorBackend.search(queryVec, { topK, scoreThreshold: threshold })
    // hits.metadata.path → atom path; resolve back to AtomicEntry via path lookup
    return hits.filter(h => atomic.getEntry(idFromPath(h.metadata.path)))

  Cache key adds `|mode|threshold|topK` so structural ≠ semantic ≠ hybrid.

geography:
  - "src/memory/community.ts"           # add mode handling + semanticWalk
  - "src/memory/index.ts"               # plumb vectorBackend + embedder
  - "test/memory/community.test.ts"     # extend with V1-V7

api_contracts:
  - name: "CommunityRequest"
    file: "src/memory/community.ts"
    shape: |
      interface CommunityRequest {
        // existing fields …
        mode?: 'structural' | 'semantic' | 'hybrid'   // default 'structural'
        semanticThreshold?: number                     // default 0.75
        semanticTopK?: number                          // default 10
      }

  - name: "CommunityResult"
    file: "src/memory/community.ts"
    shape: |
      interface CommunityResult {
        // existing fields …
        membership_breakdown?: {
          structural: string[]
          semantic: string[]
          overlap: string[]
        }
      }

  - name: "SummarizeCommunityDeps"
    file: "src/memory/community.ts"
    shape: |
      interface SummarizeCommunityDeps {
        atomic: CommunityAtomic
        cache: CommunityCache
        vectorSearch?: SemanticSearchFn   // NEW; required for semantic/hybrid
      }
      type SemanticSearchFn = (
        seed: AtomicEntry,
        opts: { threshold: number; topK: number },
      ) => Promise<AtomicEntry[]>

verification_plan:
  - id: V1-mode-structural-default
    description: |
      Calling summarizeCommunity without `mode` returns the same result
      as today (membership_breakdown undefined). No regression.
  - id: V2-semantic-mode
    description: |
      mode:'semantic' with a stub vectorSearch returning two atoms
      → result.members contains those two ids; structural walk is
      NOT invoked. membership_breakdown.semantic has 2, structural empty.
  - id: V3-hybrid-merges-and-dedupes
    description: |
      Stub vectorSearch returns ['A','B']; structural walk returns
      ['B','C']. Hybrid mode → members ['A','B','C']
      (sorted), breakdown.overlap=['B'].
  - id: V4-semantic-without-search-throws
    description: |
      mode:'semantic' but deps.vectorSearch undefined → clear error
      explaining the dependency.
  - id: V5-cache-disambiguates-mode
    description: |
      Two calls — same seed/hops, different mode — return distinct
      results, neither marked cached. Re-call with same args → cached.
  - id: V6-threshold-filters
    description: |
      vectorSearch returns 5 results; threshold=0.9 → only the 2
      above-threshold land in members.
  - id: V7-no-LLM-extra-cost
    description: |
      Semantic mode invokes vectorSearch once; no extra LLM call vs
      structural mode (synthesis cost identical).

implementation_steps:
  - 1. Extend CommunityRequest + CommunityResult + SummarizeCommunityDeps
       per the api_contracts above.
  - 2. Implement semanticWalk() helper inside community.ts.
  - 3. Update summarizeCommunity to dispatch by mode + populate
       membership_breakdown.
  - 4. Update cache key to include mode/threshold/topK.
  - 5. MemoryStore.summarizeCommunity wires deps.vectorSearch by
       composing the existing embedder + atomic vector store.
  - 6. Tests V1-V7 with stub vectorSearch (no real embedder calls).
```
