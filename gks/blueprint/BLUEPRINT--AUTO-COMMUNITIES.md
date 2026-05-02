---
id: BLUEPRINT--AUTO-COMMUNITIES
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Auto-detected communities
crosslinks: {"parent_adr":["ADR--AUTO-COMMUNITIES"],"parent_concept":["CONCEPT--AUTO-COMMUNITIES"]}
linked_symbols:
  - {"file":"src/memory/community-detect.ts","fn":"detectCommunities"}
  - {"file":"src/memory/community-detect.ts","fn":"buildAtomGraph"}
  - {"file":"src/memory/community-detect.ts","fn":"louvainLite"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.detectCommunities"}
created_at: 2026-05-02T06:34:25.296Z
---

# BLUEPRINT — Auto-detected communities

```yaml
metadata:
  title: "Auto-detected communities via in-house Louvain-lite"
  status: draft

architectural_pattern: |
  Pure read-side primitive over the atomic_index. Build undirected
  edge multiset from crosslinks; run single-pass greedy modularity
  maximisation; group by final community label; sort + emit
  DetectedCommunity[]. No persistence, no schema change.

data_logic: |
  Step 1 — buildAtomGraph(atomic, edgeKeys?):
    nodes = sorted(atomic.filter({}).map(e => e.id))
    edges = Set<string>()  // canonical "min|max" pair
    for entry in atomic.entries:
      for [predicate, targets] of entry.crosslinks:
        if (edgeKeys && !edgeKeys.includes(predicate)) continue
        for target in targets:
          if (target == entry.id) continue              // skip self-loop
          if (!atomic.getEntry(target)) continue        // skip dangling
          const [a, b] = sortedPair(entry.id, target)
          edges.add(`${a}|${b}`)
    return { nodes, edges: Array.from(edges) }

  Step 2 — louvainLite(nodes, edges):
    community = Map<nodeId, communityId>  // start: each node in its own
    for node in nodes (lex sorted):
      community.set(node, node)

    let moved = true
    let safety = nodes.length * 4   // hard iteration cap
    while (moved && safety-- > 0):
      moved = false
      for node in nodes (lex sorted):
        const candidates = computeNeighbourCommunityGains(node, edges, community)
        // candidates: Map<communityId, gain>
        const best = pickBest(candidates)              // ties: lex smallest
        if (best && best.gain > 0 && best.cid !== community.get(node)):
          community.set(node, best.cid)
          moved = true

    return community

  Step 3 — group results:
    byCommunity: Map<rawCid, AtomicEntry[]>
    for [nodeId, cid] of community: byCommunity.get(cid).push(nodeId)
    for each cluster:
      members = sort(by phase asc, id asc)
      community_id = members[0]                          // lex smallest
      density = countIntraEdges(members, edges) / (n*(n-1)/2)
    orphans = clusters with size === 1 → flatten ids

  modularity Q = totalIntraEdges/totalEdges - sum((degSum/2m)^2)

geography:
  - "src/memory/community-detect.ts"   # NEW
  - "src/memory/index.ts"              # MemoryStore.detectCommunities()
  - "test/memory/community-detect.test.ts"  # NEW

api_contracts:
  - name: "detectCommunities"
    file: "src/memory/community-detect.ts"
    shape: |
      interface DetectCommunitiesOptions {
        edgeKeys?: string[]    // default: all crosslink predicates
        minSize?: number       // default: 2 (singletons → orphans)
      }
      interface DetectedCommunity {
        community_id: string
        members: string[]      // sorted phase asc, id asc
        size: number
        density: number        // 0..1
      }
      interface DetectCommunitiesResult {
        communities: DetectedCommunity[]
        orphans: string[]
        total_atoms: number
        total_edges: number
        modularity: number
      }
      function detectCommunities(
        atomic: CommunityAtomic & { filter(query: {}): AtomicEntry[] },
        opts?: DetectCommunitiesOptions,
      ): DetectCommunitiesResult

  - name: "MemoryStore.detectCommunities"
    file: "src/memory/index.ts"
    shape: |
      class MemoryStore {
        detectCommunities(opts?: DetectCommunitiesOptions): DetectCommunitiesResult
      }

verification_plan:
  - id: V1-deterministic-output
    description: |
      Two consecutive calls on the same atomic index return
      byte-identical communities + community_ids + ordering.
  - id: V2-orphan-detection
    description: |
      A fixture with two connected pairs + one isolated atom →
      result has 2 communities, orphans = [the isolated id].
  - id: V3-density-correct
    description: |
      A 3-clique (3 nodes, 3 edges) → density = 1.0.
      A 3-path (3 nodes, 2 edges) → density = 2/3.
  - id: V4-respects-edgeKeys
    description: |
      Restricting edgeKeys=['references'] excludes 'parent_concept'
      edges; the resulting communities reflect the smaller edge set.
  - id: V5-skips-dangling
    description: |
      A crosslink target that doesn't exist in the index is silently
      ignored (no error, no phantom community).
  - id: V6-modularity-bounded
    description: |
      result.modularity is within [-0.5, 1.0]. (Greedy Louvain rarely
      hits 1.0 but should be > 0 on any non-trivial graph.)
  - id: V7-integrates-with-summarize
    description: |
      End-to-end: detectCommunities() → loop over communities →
      summarizeCommunity({ seed: c.members }) for each → produces
      one synthesis per cluster. Smoke test verifies the chain works.

implementation_steps:
  - 1. Build src/memory/community-detect.ts: buildAtomGraph,
       louvainLite, modularity helpers, public detectCommunities().
  - 2. Wire MemoryStore.detectCommunities()
  - 3. Public exports in src/memory/index.ts.
  - 4. Tests V1-V7 with a small hand-built fixture.
  - 5. Optional CLI: `gks community detect` follow-up (not in this
       BLUEPRINT — separate small change).
```
