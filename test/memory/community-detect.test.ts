/**
 * Tests for detectCommunities (BLUEPRINT--AUTO-COMMUNITIES, V1-V7).
 */

import { describe, it, expect } from 'vitest'

import {
  buildAtomGraph,
  detectCommunities,
  louvainLite,
  type CommunityAtomicWithFilter,
} from '../../src/memory/community-detect.js'
import type { AtomicEntry, AtomicNote } from '../../src/memory/types.js'

function entry(
  id: string,
  phase: 0 | 1 | 2 | 3 | 4 | 5,
  type: string,
  crosslinks?: Record<string, string[]>,
): AtomicEntry {
  return {
    id,
    phase,
    type,
    status: 'stable',
    vault_id: 'default',
    path: `${type}/${id}.md`,
    ...(crosslinks ? { crosslinks } : {}),
  }
}

function makeAtomic(entries: AtomicEntry[]): CommunityAtomicWithFilter {
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    getEntry(id) {
      return byId.get(id)
    },
    async lookup(id) {
      const e = byId.get(id)
      if (!e) return null
      return { ...e, body: '' } as AtomicNote
    },
    filter() {
      return [...entries]
    },
  }
}

describe('buildAtomGraph', () => {
  it('canonicalises edges so multi-predicate pairs count once', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'], implements: ['B'] }),
      entry('B', 2, 'feat'),
    ]
    const g = buildAtomGraph(makeAtomic(atoms))
    expect(g.nodes).toEqual(['A', 'B'])
    expect(g.edges.size).toBe(1)
    expect(g.edges.has('A|B')).toBe(true)
  })

  it('drops self-loops + dangling targets', () => {
    const atoms = [
      entry('A', 1, 'concept', {
        references: ['A', 'NOT--EXIST'],
      }),
    ]
    const g = buildAtomGraph(makeAtomic(atoms))
    expect(g.edges.size).toBe(0)
  })

  it('respects edgeKeys filter', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'], parent_concept: ['C'] }),
      entry('B', 2, 'feat'),
      entry('C', 1, 'concept'),
    ]
    const all = buildAtomGraph(makeAtomic(atoms))
    expect(all.edges.size).toBe(2)
    const onlyRefs = buildAtomGraph(makeAtomic(atoms), ['references'])
    expect(onlyRefs.edges.size).toBe(1)
    expect(onlyRefs.edges.has('A|B')).toBe(true)
  })
})

describe('detectCommunities', () => {
  it('V1: deterministic — two runs yield byte-identical results', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'] }),
      entry('B', 2, 'feat', { references: ['C'] }),
      entry('C', 1, 'concept'),
      entry('D', 1, 'concept', { references: ['E'] }),
      entry('E', 2, 'feat'),
    ]
    const r1 = detectCommunities(makeAtomic(atoms))
    const r2 = detectCommunities(makeAtomic(atoms))
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })

  it('V2: orphan detection — isolated atom appears in orphans', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'] }),
      entry('B', 2, 'feat'),
      entry('C', 1, 'concept', { references: ['D'] }),
      entry('D', 2, 'feat'),
      entry('LONE', 0, 'insight'), // no crosslinks anywhere
    ]
    const r = detectCommunities(makeAtomic(atoms))
    expect(r.communities.length).toBeGreaterThanOrEqual(2)
    expect(r.orphans).toContain('LONE')
  })

  it('V3: density on a 3-clique = 1.0; 3-path = 2/3', () => {
    // 3-clique: A-B, B-C, A-C
    const clique = [
      entry('A', 1, 'concept', { references: ['B', 'C'] }),
      entry('B', 1, 'concept', { references: ['C'] }),
      entry('C', 1, 'concept'),
    ]
    const rClique = detectCommunities(makeAtomic(clique), { minSize: 1 })
    const triangle = rClique.communities.find((c) => c.members.includes('A'))
    expect(triangle?.density).toBeCloseTo(1.0, 5)

    // 3-path: A-B, B-C only
    const path = [
      entry('A', 1, 'concept', { references: ['B'] }),
      entry('B', 1, 'concept', { references: ['C'] }),
      entry('C', 1, 'concept'),
    ]
    const rPath = detectCommunities(makeAtomic(path), { minSize: 1 })
    // The path may end up as one community or split — check density of
    // whichever community contains all 3.
    const whole = rPath.communities.find((c) => c.size === 3)
    if (whole) expect(whole.density).toBeCloseTo(2 / 3, 5)
  })

  it('V4: edgeKeys restricts which crosslinks contribute', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'], parent_concept: ['C'] }),
      entry('B', 2, 'feat'),
      entry('C', 1, 'concept'),
    ]
    const all = detectCommunities(makeAtomic(atoms), { minSize: 1 })
    expect(all.total_edges).toBe(2)

    const onlyRefs = detectCommunities(makeAtomic(atoms), {
      // default minSize=2 → singletons go to orphans
      edgeKeys: ['references'],
    })
    expect(onlyRefs.total_edges).toBe(1)
    // C has no `references` edges → singleton → orphan.
    expect(onlyRefs.orphans).toContain('C')
  })

  it('V5: dangling crosslink targets are silently dropped', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B', 'NEVER--EXISTED'] }),
      entry('B', 2, 'feat'),
    ]
    const r = detectCommunities(makeAtomic(atoms))
    expect(r.total_edges).toBe(1)
    // No phantom 'NEVER--EXISTED' entry anywhere.
    const ids = r.communities.flatMap((c) => c.members).concat(r.orphans)
    expect(ids).not.toContain('NEVER--EXISTED')
  })

  it('V6: modularity is in [-0.5, 1.0] and positive on non-trivial graphs', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'] }),
      entry('B', 2, 'feat'),
      entry('C', 1, 'concept', { references: ['D'] }),
      entry('D', 2, 'feat'),
    ]
    const r = detectCommunities(makeAtomic(atoms))
    expect(r.modularity).toBeGreaterThanOrEqual(-0.5)
    expect(r.modularity).toBeLessThanOrEqual(1.0)
    expect(r.modularity).toBeGreaterThan(0)
  })

  it('V7: integrates with summarizeCommunity end-to-end', async () => {
    const { summarizeCommunity, CommunityCache } = await import(
      '../../src/memory/community.js'
    )
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'] }),
      entry('B', 2, 'feat'),
      entry('C', 1, 'concept', { references: ['D'] }),
      entry('D', 2, 'feat'),
    ]
    const atomic = makeAtomic(atoms)
    // detect → loop → summarise
    const detected = detectCommunities(atomic)
    expect(detected.communities.length).toBeGreaterThan(0)

    const cache = new CommunityCache()
    for (const c of detected.communities) {
      const r = await summarizeCommunity(
        { atomic, cache },
        { seed: c.members, hops: 0 },
      )
      expect(r.members.length).toBeGreaterThan(0)
      expect(r.summary).toBeTruthy()
    }
  })

  it('community_id is the lex-smallest member', () => {
    const atoms = [
      entry('Z--LATER', 1, 'concept', { references: ['A--FIRST'] }),
      entry('A--FIRST', 2, 'feat'),
    ]
    const r = detectCommunities(makeAtomic(atoms), { minSize: 1 })
    const c = r.communities[0]
    expect(c?.community_id).toBe('A--FIRST')
  })

  it('total_atoms + total_edges reported correctly', () => {
    const atoms = [
      entry('A', 1, 'concept', { references: ['B'] }),
      entry('B', 2, 'feat'),
      entry('C', 0, 'insight'),
    ]
    const r = detectCommunities(makeAtomic(atoms), { minSize: 1 })
    expect(r.total_atoms).toBe(3)
    expect(r.total_edges).toBe(1)
  })

  it('handles empty atom store gracefully', () => {
    const r = detectCommunities(makeAtomic([]))
    expect(r.communities).toEqual([])
    expect(r.orphans).toEqual([])
    expect(r.modularity).toBe(0)
  })
})

describe('louvainLite', () => {
  it('returns a partition where every node has a community label', () => {
    const nodes = ['A', 'B', 'C']
    const edges = new Set(['A|B'])
    const degree = new Map([
      ['A', 1],
      ['B', 1],
      ['C', 0],
    ])
    const community = louvainLite(nodes, edges, degree)
    expect(community.size).toBe(3)
    for (const n of nodes) expect(community.get(n)).toBeDefined()
  })

  it('groups densely-connected nodes together', () => {
    const nodes = ['A', 'B', 'C', 'X', 'Y']
    // Two cliques: ABC and XY, no cross edges
    const edges = new Set(['A|B', 'A|C', 'B|C', 'X|Y'])
    const degree = new Map([
      ['A', 2],
      ['B', 2],
      ['C', 2],
      ['X', 1],
      ['Y', 1],
    ])
    const community = louvainLite(nodes, edges, degree)
    // A, B, C should share a community; X, Y should share another.
    expect(community.get('A')).toBe(community.get('B'))
    expect(community.get('A')).toBe(community.get('C'))
    expect(community.get('X')).toBe(community.get('Y'))
    expect(community.get('A')).not.toBe(community.get('X'))
  })
})
