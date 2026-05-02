/**
 * Tests for summarizeCommunity (BLUEPRINT--COMMUNITY-SUMMARIES, V1-V7).
 *
 * Uses a hand-built in-memory CommunityAtomic stub so we can exercise
 * the walk + cache + synthesis logic without touching disk or LLMs.
 */

import { describe, it, expect } from 'vitest'

import {
  CommunityCache,
  buildCommunityPrompt,
  summarizeCommunity,
  walkCommunity,
  type CommunityAtomic,
} from '../../src/memory/community.js'
import { heuristicTldrGenerator, type TldrGenerator } from '../../src/memory/tldr.js'
import type { AtomicEntry, AtomicNote } from '../../src/memory/types.js'

function entry(
  id: string,
  phase: 0 | 1 | 2 | 3 | 4 | 5,
  type: string,
  opts: {
    title?: string
    summary_tldr?: string
    crosslinks?: Record<string, string[]>
    body?: string
  } = {},
): AtomicEntry & { __body: string } {
  const e: AtomicEntry & { __body: string } = {
    id,
    phase,
    type,
    status: 'stable',
    vault_id: 'default',
    path: `${type}/${id}.md`,
    __body: opts.body ?? `Body of ${id}.`,
  }
  if (opts.title) e.title = opts.title
  if (opts.summary_tldr) e.summary_tldr = opts.summary_tldr
  if (opts.crosslinks) e.crosslinks = opts.crosslinks
  return e
}

function makeAtomic(entries: Array<AtomicEntry & { __body: string }>): CommunityAtomic {
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    getEntry(id) {
      return byId.get(id)
    },
    async lookup(id) {
      const e = byId.get(id)
      if (!e) return null
      const note: AtomicNote = { ...e, body: e.__body }
      return note
    },
  }
}

// Sample chain: FEAT → BLUEPRINT → ADR → CONCEPT (4-deep), plus a side
// branch that lives at depth 1 from the FEAT.
function chainFixture() {
  return [
    entry('CONCEPT--A', 1, 'concept', {
      title: 'Concept A',
      summary_tldr: 'Concept A introduces the idea.',
    }),
    entry('ADR--A', 2, 'adr', {
      title: 'ADR A',
      summary_tldr: 'ADR A records the decision.',
      crosslinks: { parent_concept: ['CONCEPT--A'] },
    }),
    entry('BLUEPRINT--A', 3, 'blueprint', {
      title: 'Blueprint A',
      summary_tldr: 'Blueprint A plans the implementation.',
      crosslinks: { parent_adr: ['ADR--A'] },
    }),
    entry('FEAT--A', 2, 'feat', {
      title: 'Feature A',
      summary_tldr: 'Feature A delivers the user-facing behaviour.',
      crosslinks: {
        parent_blueprint: ['BLUEPRINT--A'],
        references: ['SIDE--NOTE'],
      },
    }),
    entry('SIDE--NOTE', 1, 'concept', {
      title: 'Side Note',
      summary_tldr: 'A side note referenced by the feature.',
    }),
    // A 4th-level deep node, only reachable at hops>=3 from FEAT--A.
    entry('CONCEPT--ROOT', 0, 'concept', {
      title: 'Root',
      summary_tldr: 'Root concept far away.',
    }),
  ]
}

describe('walkCommunity', () => {
  it('V1: returns the same member list across runs (deterministic order)', () => {
    const atomic = makeAtomic(chainFixture())
    const r1 = walkCommunity(atomic, 'FEAT--A', { hops: 1, edges: ['parent_blueprint', 'references'], maxMembers: 30 })
    const r2 = walkCommunity(atomic, 'FEAT--A', { hops: 1, edges: ['parent_blueprint', 'references'], maxMembers: 30 })
    expect(r1.members.map((m) => m.id)).toEqual(r2.members.map((m) => m.id))
    // Sorted by phase ascending then id — Side at phase 1, Feature at 2, Blueprint at 3.
    expect(r1.members.map((m) => m.id)).toEqual(['SIDE--NOTE', 'FEAT--A', 'BLUEPRINT--A'])
  })

  it('V2: hop budget bounds the walk depth', () => {
    const atomic = makeAtomic(chainFixture())
    // hops=1: only direct neighbours (BLUEPRINT-A, SIDE-NOTE) in addition to seed.
    const r1 = walkCommunity(atomic, 'FEAT--A', {
      hops: 1,
      edges: ['parent_blueprint', 'parent_adr', 'parent_concept', 'references'],
      maxMembers: 30,
    })
    expect(r1.members.map((m) => m.id).sort()).toEqual(
      ['BLUEPRINT--A', 'FEAT--A', 'SIDE--NOTE'].sort(),
    )

    // hops=3: full chain including CONCEPT-A.
    const r3 = walkCommunity(atomic, 'FEAT--A', {
      hops: 3,
      edges: ['parent_blueprint', 'parent_adr', 'parent_concept', 'references'],
      maxMembers: 30,
    })
    expect(r3.members.map((m) => m.id).sort()).toEqual(
      ['ADR--A', 'BLUEPRINT--A', 'CONCEPT--A', 'FEAT--A', 'SIDE--NOTE'].sort(),
    )
  })

  it('V3: maxMembers cap fires and reports truncated', () => {
    const atomic = makeAtomic(chainFixture())
    const r = walkCommunity(atomic, 'FEAT--A', {
      hops: 3,
      edges: ['parent_blueprint', 'parent_adr', 'parent_concept', 'references'],
      maxMembers: 2,
    })
    expect(r.members.length).toBe(2)
    expect(r.truncated).toBe(true)
  })

  it('skips edges not in the allowed set', () => {
    const atomic = makeAtomic(chainFixture())
    // Only follow `references`, not `parent_blueprint`. From FEAT--A we
    // get SIDE--NOTE but NOT BLUEPRINT--A.
    const r = walkCommunity(atomic, 'FEAT--A', {
      hops: 3,
      edges: ['references'],
      maxMembers: 30,
    })
    expect(r.members.map((m) => m.id).sort()).toEqual(['FEAT--A', 'SIDE--NOTE'].sort())
  })

  it('handles seed array input', () => {
    const atomic = makeAtomic(chainFixture())
    const r = walkCommunity(atomic, ['CONCEPT--A', 'SIDE--NOTE'], {
      hops: 0,
      edges: [],
      maxMembers: 30,
    })
    expect(r.members.map((m) => m.id).sort()).toEqual(['CONCEPT--A', 'SIDE--NOTE'])
  })
})

describe('buildCommunityPrompt', () => {
  it('V4: prefers summary_tldr when present and includeBodies=false', async () => {
    const atomic = makeAtomic(chainFixture())
    const members = [chainFixture()[0]!] // CONCEPT--A
    const out = await buildCommunityPrompt(atomic, members, false)
    expect(out.text).toContain('Atom: CONCEPT--A')
    expect(out.text).toContain('Concept A introduces the idea.')
    expect(out.usedTldrCount).toBe(1)
    expect(out.usedBodyCount).toBe(0)
  })

  it('V4: falls back to body when atom has no summary_tldr', async () => {
    const noTldr = entry('NOTE--BODY-ONLY', 1, 'insight', {
      title: 'Body only',
      body: 'Just the body, no TLDR set.',
    })
    const atomic = makeAtomic([noTldr])
    const out = await buildCommunityPrompt(atomic, [noTldr], false)
    expect(out.text).toContain('Just the body')
    expect(out.usedTldrCount).toBe(0)
    expect(out.usedBodyCount).toBe(1)
  })

  it('uses body when includeBodies=true even if TLDR is set', async () => {
    const e = entry('NOTE--BOTH', 1, 'insight', {
      title: 'Both',
      summary_tldr: 'Short tldr.',
      body: 'Long body content here.',
    })
    const atomic = makeAtomic([e])
    const out = await buildCommunityPrompt(atomic, [e], true)
    expect(out.text).toContain('Long body content here.')
    expect(out.usedBodyCount).toBe(1)
    expect(out.usedTldrCount).toBe(0)
  })
})

describe('summarizeCommunity (synthesis + cache)', () => {
  it('V6: heuristic generator produces a deterministic bullet-list summary', async () => {
    const atomic = makeAtomic(chainFixture())
    const cache = new CommunityCache()
    const result = await summarizeCommunity(
      { atomic, cache },
      {
        seed: 'FEAT--A',
        hops: 3,
        edges: ['parent_blueprint', 'parent_adr', 'parent_concept'],
      },
    )
    // Default generator is heuristic.
    expect(result.generator).toBe('heuristic')
    expect(result.summary).toContain('- **CONCEPT--A**')
    expect(result.summary).toContain('- **ADR--A**')
    expect(result.summary).toContain('- **BLUEPRINT--A**')
    expect(result.summary).toContain('- **FEAT--A**')
    expect(result.cached).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.members.length).toBe(4)
  })

  it('V5: identical args hit the LRU cache on the second call', async () => {
    const atomic = makeAtomic(chainFixture())
    const cache = new CommunityCache()
    const a = await summarizeCommunity({ atomic, cache }, { seed: 'FEAT--A', hops: 1 })
    expect(a.cached).toBe(false)
    const b = await summarizeCommunity({ atomic, cache }, { seed: 'FEAT--A', hops: 1 })
    expect(b.cached).toBe(true)
    expect(b.summary).toBe(a.summary)
    expect(b.members).toEqual(a.members)
  })

  it('V5: different args produce a fresh result', async () => {
    const atomic = makeAtomic(chainFixture())
    const cache = new CommunityCache()
    await summarizeCommunity({ atomic, cache }, { seed: 'FEAT--A', hops: 1 })
    const c = await summarizeCommunity(
      { atomic, cache },
      { seed: 'FEAT--A', hops: 1, includeBodies: true },
    )
    expect(c.cached).toBe(false)
  })

  it('V7: LLM-backed generator output is returned verbatim', async () => {
    const atomic = makeAtomic(chainFixture())
    const cache = new CommunityCache()
    const llmGenerator: TldrGenerator = {
      name: 'llm:mock',
      async summarize(_text, opts) {
        // Confirms the prompt routes through with opts.type='community'.
        expect(opts?.type).toBe('community')
        return 'A coherent narrative across the chain, citing CONCEPT--A through FEAT--A.'
      },
    }
    const result = await summarizeCommunity(
      { atomic, cache },
      {
        seed: 'FEAT--A',
        hops: 3,
        edges: ['parent_blueprint', 'parent_adr', 'parent_concept'],
        generator: llmGenerator,
      },
    )
    expect(result.generator).toBe('llm:mock')
    expect(result.summary).toContain('coherent narrative')
  })

  it('falls back to heuristic when LLM returns empty', async () => {
    const atomic = makeAtomic(chainFixture())
    const cache = new CommunityCache()
    const empty: TldrGenerator = {
      name: 'llm:empty',
      async summarize() {
        return '   \n  '
      },
    }
    const result = await summarizeCommunity(
      { atomic, cache },
      { seed: 'FEAT--A', generator: empty, hops: 1 },
    )
    // Should have synthesised via the heuristic fallback.
    expect(result.summary).toContain('- **')
  })

  it('returns empty result when seed does not exist', async () => {
    const atomic = makeAtomic(chainFixture())
    const cache = new CommunityCache()
    const result = await summarizeCommunity(
      { atomic, cache },
      { seed: 'NONEXISTENT--ATOM' },
    )
    expect(result.members).toEqual([])
    expect(result.summary).toBe('')
  })

  it('clamps hops to MAX_HOPS=3 silently', async () => {
    const atomic = makeAtomic(chainFixture())
    const cache = new CommunityCache()
    const r = await summarizeCommunity(
      { atomic, cache },
      { seed: 'FEAT--A', hops: 99 },
    )
    // The walk respected the cap; same result as hops=3 (which collects 4 atoms here).
    expect(r.members.length).toBeLessThanOrEqual(5)
  })
})

describe('CommunityCache LRU eviction', () => {
  it('evicts the least-recently-touched entry when full', () => {
    const cache = new CommunityCache()
    // Stuff 70 entries (cap is 64) — first ones should evict.
    for (let i = 0; i < 70; i++) {
      cache.set(`k${i}`, {
        members: [`a${i}`],
        summary: `s${i}`,
        truncated: false,
        cached: false,
        inputTokensEstimate: 0,
        generator: 'heuristic',
      })
    }
    expect(cache.size()).toBe(64)
    expect(cache.get('k0')).toBeUndefined() // evicted
    expect(cache.get('k69')).toBeDefined() // still present
  })
})

describe('MemoryStore.summarizeCommunity (integration)', () => {
  it('exposes the method on MemoryStore and walks the actual repo atom tree', async () => {
    const { MemoryStore } = await import('../../src/memory/index.js')
    const { mockEmbedder } = await import('../../src/memory/vector/embedder.js')
    const store = new MemoryStore({
      root: process.cwd(),
      embedder: mockEmbedder(64),
    })
    await store.init()
    // Use the SUMMARY-TLDR chain we promoted earlier in this branch.
    const result = await store.summarizeCommunity({
      seed: 'FEAT--SUMMARY-TLDR',
      hops: 3,
      edges: ['parent_blueprint', 'parent_adr', 'parent_concept', 'references'],
    })
    expect(result.members).toContain('FEAT--SUMMARY-TLDR')
    expect(result.summary.length).toBeGreaterThan(0)
    expect(result.generator).toBe('heuristic')
  })
})

// ─── V1-V7: SEMANTIC-COMMUNITY mode ─────────────────────────────────────

describe('summarizeCommunity (semantic / hybrid mode)', () => {
  function smallFixture() {
    return [
      entry('CONCEPT--ALPHA', 1, 'concept', { title: 'Alpha', summary_tldr: 'Alpha intro.' }),
      entry('ADR--ALPHA', 2, 'adr', {
        title: 'ADR Alpha',
        summary_tldr: 'Alpha decision.',
        crosslinks: { parent_concept: ['CONCEPT--ALPHA'] },
      }),
      entry('FEAT--ALPHA', 2, 'feat', {
        title: 'Feat Alpha',
        summary_tldr: 'Alpha feature.',
        crosslinks: { parent_adr: ['ADR--ALPHA'] },
      }),
      entry('INSIGHT--ORPHAN', 1, 'insight', {
        title: 'Orphan',
        summary_tldr: 'No crosslink to anything.',
      }),
    ]
  }

  it('V1: mode default is structural — behaviour unchanged, no breakdown field', async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    const r = await summarizeCommunity({ atomic, cache }, { seed: 'FEAT--ALPHA', hops: 3 })
    expect(r.membership_breakdown).toBeUndefined()
    expect(r.members).toContain('FEAT--ALPHA')
  })

  it("V2: mode:'semantic' uses vectorSearch only and skips structural walk", async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    let walkCalls = 0
    const fixtures = smallFixture()
    const vectorSearch: import('../../src/memory/community.js').SemanticSearchFn = async () => {
      walkCalls++
      return [fixtures.find((f) => f.id === 'INSIGHT--ORPHAN')!, fixtures.find((f) => f.id === 'CONCEPT--ALPHA')!]
    }
    const r = await summarizeCommunity(
      { atomic, cache, vectorSearch },
      { seed: 'FEAT--ALPHA', mode: 'semantic' },
    )
    expect(walkCalls).toBe(1)
    expect(r.members.sort()).toEqual(['CONCEPT--ALPHA', 'INSIGHT--ORPHAN'].sort())
    expect(r.membership_breakdown).toBeDefined()
    expect(r.membership_breakdown!.semantic).toEqual(['CONCEPT--ALPHA', 'INSIGHT--ORPHAN'].sort())
    expect(r.membership_breakdown!.structural).toEqual([])
    expect(r.membership_breakdown!.overlap).toEqual([])
  })

  it("V3: mode:'hybrid' merges structural + semantic with overlap detection", async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    const fixtures = smallFixture()
    // Semantic returns 'A' (overlap with structural via FEAT chain) + 'ORPHAN'.
    const vectorSearch: import('../../src/memory/community.js').SemanticSearchFn = async () => [
      fixtures.find((f) => f.id === 'ADR--ALPHA')!,
      fixtures.find((f) => f.id === 'INSIGHT--ORPHAN')!,
    ]
    const r = await summarizeCommunity(
      { atomic, cache, vectorSearch },
      {
        seed: 'FEAT--ALPHA',
        hops: 1,
        edges: ['parent_adr'], // structural will pull ADR--ALPHA
        mode: 'hybrid',
      },
    )
    // Members: structural [FEAT--ALPHA, ADR--ALPHA] ∪ semantic [ADR--ALPHA, ORPHAN]
    expect(r.members.sort()).toEqual(['ADR--ALPHA', 'FEAT--ALPHA', 'INSIGHT--ORPHAN'].sort())
    expect(r.membership_breakdown!.overlap).toContain('ADR--ALPHA')
    expect(r.membership_breakdown!.semantic).toContain('INSIGHT--ORPHAN')
  })

  it('V4: mode:semantic without vectorSearch throws a clear error', async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    await expect(
      summarizeCommunity({ atomic, cache }, { seed: 'FEAT--ALPHA', mode: 'semantic' }),
    ).rejects.toThrow(/requires deps\.vectorSearch/)
  })

  it('V5: cache key includes mode — structural ≠ semantic', async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    const fixtures = smallFixture()
    const vectorSearch: import('../../src/memory/community.js').SemanticSearchFn = async () => [
      fixtures.find((f) => f.id === 'INSIGHT--ORPHAN')!,
    ]
    const a = await summarizeCommunity({ atomic, cache, vectorSearch }, { seed: 'FEAT--ALPHA' })
    expect(a.cached).toBe(false)
    const b = await summarizeCommunity(
      { atomic, cache, vectorSearch },
      { seed: 'FEAT--ALPHA', mode: 'semantic' },
    )
    expect(b.cached).toBe(false) // different mode → fresh
    const c = await summarizeCommunity({ atomic, cache, vectorSearch }, { seed: 'FEAT--ALPHA' })
    expect(c.cached).toBe(true) // same args as `a` → cached
  })

  it('V6: semantic threshold is forwarded to vectorSearch', async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    let receivedThreshold = -1
    let receivedTopK = -1
    const vectorSearch: import('../../src/memory/community.js').SemanticSearchFn = async (
      _seeds,
      opts,
    ) => {
      receivedThreshold = opts.threshold
      receivedTopK = opts.topK
      return []
    }
    await summarizeCommunity(
      { atomic, cache, vectorSearch },
      { seed: 'FEAT--ALPHA', mode: 'semantic', semanticThreshold: 0.92, semanticTopK: 5 },
    )
    expect(receivedThreshold).toBe(0.92)
    expect(receivedTopK).toBe(5)
  })

  it("V7: mode:'semantic' invokes generator exactly once (no extra LLM cost vs structural)", async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    const fixtures = smallFixture()
    const vectorSearch: import('../../src/memory/community.js').SemanticSearchFn = async () => [
      fixtures.find((f) => f.id === 'CONCEPT--ALPHA')!,
    ]
    let generatorCalls = 0
    const generator: TldrGenerator = {
      name: 'llm:counted',
      async summarize() {
        generatorCalls++
        return 'mock synthesis'
      },
    }
    await summarizeCommunity(
      { atomic, cache, vectorSearch },
      { seed: 'FEAT--ALPHA', mode: 'semantic', generator },
    )
    expect(generatorCalls).toBe(1)
  })

  it("mode:'semantic' returns empty when seed isn't in the atom store", async () => {
    const atomic = makeAtomic(smallFixture())
    const cache = new CommunityCache()
    const vectorSearch: import('../../src/memory/community.js').SemanticSearchFn = async () => []
    const r = await summarizeCommunity(
      { atomic, cache, vectorSearch },
      { seed: 'NONEXISTENT--ID', mode: 'semantic' },
    )
    expect(r.members).toEqual([])
  })
})
