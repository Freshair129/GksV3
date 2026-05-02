/**
 * Auto-detected communities via in-house Louvain-lite.
 *
 * Implements BLUEPRINT--AUTO-COMMUNITIES — pure read-side primitive
 * over the atomic index. No persistence, no schema change, no
 * dependencies. Single-pass greedy modularity maximisation with
 * lex-sorted iteration for deterministic output.
 */

import type { AtomicEntry } from './types.js'
import type { CommunityAtomic } from './community.js'

export interface DetectCommunitiesOptions {
  /** Restrict edges to specific crosslink predicates. Default: all keys. */
  edgeKeys?: string[]
  /** Clusters with fewer members go to `orphans` instead. Default 2. */
  minSize?: number
}

export interface DetectedCommunity {
  /** Lex-smallest member id (stable across runs for the same input). */
  community_id: string
  /** Member ids, sorted by phase asc then id asc. */
  members: string[]
  size: number
  /** Intra-community edges / max possible (n*(n-1)/2). 0..1. */
  density: number
}

export interface DetectCommunitiesResult {
  communities: DetectedCommunity[]
  orphans: string[]
  total_atoms: number
  total_edges: number
  /** Global modularity Q in [-0.5, 1.0]. */
  modularity: number
}

/** Atomic surface this module needs — reuses CommunityAtomic + adds `filter`. */
export interface CommunityAtomicWithFilter extends CommunityAtomic {
  filter(query: Record<string, never>): AtomicEntry[]
}

/**
 * Build the undirected edge multiset from atom crosslinks.
 * Edges are canonicalised as `${min}|${max}` strings to deduplicate
 * pairs reached via multiple predicates.
 */
export function buildAtomGraph(
  atomic: CommunityAtomicWithFilter,
  edgeKeys?: string[],
): { nodes: string[]; edges: Set<string>; degree: Map<string, number> } {
  const entries = atomic.filter({})
  const ids = new Set<string>(entries.map((e) => e.id))
  const edges = new Set<string>()
  const degree = new Map<string, number>()
  for (const id of ids) degree.set(id, 0)

  const allowedKey = (k: string) => !edgeKeys || edgeKeys.includes(k)

  for (const entry of entries) {
    const cl = entry.crosslinks
    if (!cl) continue
    for (const [predicate, targets] of Object.entries(cl)) {
      if (!allowedKey(predicate)) continue
      if (!Array.isArray(targets)) continue
      for (const target of targets) {
        if (typeof target !== 'string') continue
        if (target === entry.id) continue
        if (!ids.has(target)) continue
        const [a, b] = entry.id < target ? [entry.id, target] : [target, entry.id]
        const key = `${a}|${b}`
        if (!edges.has(key)) {
          edges.add(key)
          degree.set(a, (degree.get(a) ?? 0) + 1)
          degree.set(b, (degree.get(b) ?? 0) + 1)
        }
      }
    }
  }
  const nodes = [...ids].sort()
  return { nodes, edges, degree }
}

/**
 * Single-pass greedy modularity maximisation. Iterates nodes in
 * lex-sorted order; for each node, computes the modularity gain of
 * moving it to each neighbour community and picks the best (ties:
 * lex-smallest community id). Repeats until no node moves or hard
 * iteration cap is hit.
 *
 * Returns Map<nodeId, communityId>. Community ids are arbitrary
 * here — caller relabels to lex-smallest member.
 */
export function louvainLite(
  nodes: string[],
  edges: Set<string>,
  degree: Map<string, number>,
): Map<string, string> {
  const community = new Map<string, string>()
  for (const n of nodes) community.set(n, n)

  // Adjacency map for fast neighbour lookup.
  const neighbours = new Map<string, Set<string>>()
  for (const n of nodes) neighbours.set(n, new Set())
  for (const e of edges) {
    const [a, b] = e.split('|') as [string, string]
    neighbours.get(a)!.add(b)
    neighbours.get(b)!.add(a)
  }

  const m = edges.size // total edge count
  if (m === 0) return community

  // Sum of degrees per community — required for the Q-gain formula.
  const commDegSum = new Map<string, number>()
  for (const [n, c] of community) {
    commDegSum.set(c, (commDegSum.get(c) ?? 0) + (degree.get(n) ?? 0))
  }

  let safety = nodes.length * 4
  let moved = true
  while (moved && safety-- > 0) {
    moved = false
    for (const node of nodes) {
      const currentComm = community.get(node)!
      const neigh = neighbours.get(node)!
      if (neigh.size === 0) continue

      // Count edges from `node` to each candidate community.
      const edgesToComm = new Map<string, number>()
      for (const nb of neigh) {
        const c = community.get(nb)!
        edgesToComm.set(c, (edgesToComm.get(c) ?? 0) + 1)
      }

      const ki = degree.get(node) ?? 0
      const currentToOwn = edgesToComm.get(currentComm) ?? 0

      // ΔQ for moving node to community C =
      //   (k_i,C / m) - (Σ_C * k_i / 2m^2)
      // (single-pass approximation; full Louvain has a coarsening step).
      let bestComm = currentComm
      let bestGain = 0
      // Iterate candidates in lex-sorted order for tie-break determinism.
      const candidateOrder = [...edgesToComm.keys()].sort()
      for (const cand of candidateOrder) {
        if (cand === currentComm) continue
        const candEdges = edgesToComm.get(cand) ?? 0
        const sumDegCand = commDegSum.get(cand) ?? 0
        // Gain from joining `cand` − loss from leaving `currentComm`.
        const gainJoin = candEdges / m - (sumDegCand * ki) / (2 * m * m)
        const sumDegOwn = (commDegSum.get(currentComm) ?? 0) - ki
        const lossLeave = currentToOwn / m - (sumDegOwn * ki) / (2 * m * m)
        const delta = gainJoin - lossLeave
        if (delta > bestGain + 1e-9) {
          bestGain = delta
          bestComm = cand
        }
      }
      if (bestComm !== currentComm) {
        commDegSum.set(currentComm, (commDegSum.get(currentComm) ?? 0) - ki)
        commDegSum.set(bestComm, (commDegSum.get(bestComm) ?? 0) + ki)
        community.set(node, bestComm)
        moved = true
      }
    }
  }
  return community
}

/**
 * Compute global modularity Q for a partition.
 *   Q = Σ_c [ L_c / m  −  (D_c / 2m)^2 ]
 * where L_c = intra-community edge count, D_c = sum of degrees of c.
 */
function modularity(
  community: Map<string, string>,
  edges: Set<string>,
  degree: Map<string, number>,
): number {
  const m = edges.size
  if (m === 0) return 0
  const intraEdges = new Map<string, number>()
  const degSum = new Map<string, number>()
  for (const [n, c] of community) degSum.set(c, (degSum.get(c) ?? 0) + (degree.get(n) ?? 0))
  for (const e of edges) {
    const [a, b] = e.split('|') as [string, string]
    if (community.get(a) === community.get(b)) {
      const c = community.get(a)!
      intraEdges.set(c, (intraEdges.get(c) ?? 0) + 1)
    }
  }
  let q = 0
  const seenComms = new Set<string>(community.values())
  for (const c of seenComms) {
    const lc = intraEdges.get(c) ?? 0
    const dc = degSum.get(c) ?? 0
    q += lc / m - (dc / (2 * m)) ** 2
  }
  return q
}

/**
 * Public entry point. Builds the atom graph, runs louvainLite,
 * groups nodes by community, computes density + modularity, separates
 * orphans (singletons or below `minSize`), returns deterministic
 * result.
 */
export function detectCommunities(
  atomic: CommunityAtomicWithFilter,
  opts: DetectCommunitiesOptions = {},
): DetectCommunitiesResult {
  const minSize = Math.max(1, opts.minSize ?? 2)
  const edgeKeys = opts.edgeKeys
  const { nodes, edges, degree } = buildAtomGraph(atomic, edgeKeys)
  const community = louvainLite(nodes, edges, degree)
  const q = modularity(community, edges, degree)

  // Group nodes by raw community id, then relabel to lex-smallest member.
  const byRawComm = new Map<string, AtomicEntry[]>()
  for (const node of nodes) {
    const cid = community.get(node)!
    const entry = atomic.getEntry(node)
    if (!entry) continue
    const list = byRawComm.get(cid) ?? []
    list.push(entry)
    byRawComm.set(cid, list)
  }

  const communities: DetectedCommunity[] = []
  const orphans: string[] = []

  // Sort group entries deterministically.
  for (const [, members] of byRawComm) {
    const sorted = [...members].sort(
      (a, b) => a.phase - b.phase || a.id.localeCompare(b.id),
    )
    const stableLabel = [...members].map((m) => m.id).sort()[0]!
    const ids = sorted.map((m) => m.id)
    const memberSet = new Set(ids)
    let intra = 0
    for (const e of edges) {
      const [a, b] = e.split('|') as [string, string]
      if (memberSet.has(a) && memberSet.has(b)) intra++
    }
    const n = ids.length
    const maxEdges = (n * (n - 1)) / 2
    const density = maxEdges === 0 ? 1 : intra / maxEdges
    if (n < minSize) {
      orphans.push(...ids)
    } else {
      communities.push({
        community_id: stableLabel,
        members: ids,
        size: n,
        density,
      })
    }
  }

  // Stable output ordering: by community_id ascending.
  communities.sort((a, b) => a.community_id.localeCompare(b.community_id))
  orphans.sort()

  return {
    communities,
    orphans,
    total_atoms: nodes.length,
    total_edges: edges.size,
    modularity: q,
  }
}
