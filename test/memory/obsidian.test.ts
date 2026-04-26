import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  createMockObsidianAdapter,
  withCache,
  wikilinkToPath,
  extractWikilinks,
  type MockVault,
  type ObsidianAdapter,
} from '../../src/memory/obsidian-mcp.js'
import { MemoryStore } from '../../src/memory/index.js'
import { recall } from '../../src/memory/api.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

function sampleVault(): MockVault {
  return {
    notes: [
      {
        path: 'Concepts/Cortex.md',
        title: 'Cortex',
        body: 'The Cortex brain handles planning and reasoning. See [[Motor]] and [[Limbic]].',
        tags: ['brain', 'core'],
        backlinks: [],
        outlinks: ['Motor', 'Limbic'],
      },
      {
        path: 'Concepts/Motor.md',
        title: 'Motor',
        body: 'The Motor brain handles code generation via [[Qwen]].',
        tags: ['brain'],
        backlinks: [],
        outlinks: ['Qwen'],
      },
      {
        path: 'Concepts/Limbic.md',
        title: 'Limbic',
        body: 'The Limbic brain handles intent extraction through Typhoon.',
        tags: ['brain', 'affect'],
        backlinks: [],
        outlinks: [],
      },
    ],
  }
}

describe('wikilink utilities', () => {
  it('strips brackets, aliases, and heading anchors', () => {
    expect(wikilinkToPath('[[Note]]')).toBe('Note')
    expect(wikilinkToPath('[[Note|Alias]]')).toBe('Note')
    expect(wikilinkToPath('[[Note#Heading]]')).toBe('Note')
    expect(wikilinkToPath('[[Note#Heading|Alias]]')).toBe('Note')
  })
  it('extracts unique wikilinks from body text', () => {
    const body = 'Links: [[A]] and [[B]] and [[A|alias]] and [[C#heading]].'
    const out = extractWikilinks(body)
    expect(out.sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('MockObsidianAdapter', () => {
  const adapter = createMockObsidianAdapter(sampleVault())

  it('ping() returns true', async () => {
    expect(await adapter.ping()).toBe(true)
  })

  it('search() returns hits by body substring', async () => {
    const hits = await adapter.search('planning')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.title).toBe('Cortex')
  })

  it('resolveWikilink() finds note by title or path', async () => {
    const note = await adapter.resolveWikilink('[[Motor]]')
    expect(note?.title).toBe('Motor')
  })

  it('backlinksOf() walks the outlinks inverse index', async () => {
    const backs = await adapter.backlinksOf('Motor')
    expect(backs.map((b) => b.path)).toContain('Concepts/Cortex.md')
  })

  it('tagQuery() filters by exact tag (case-insensitive)', async () => {
    const hits = await adapter.tagQuery('brain')
    expect(hits).toHaveLength(3)
    const hits2 = await adapter.tagQuery('#affect')
    expect(hits2.map((h) => h.title)).toEqual(['Limbic'])
  })
})

describe('withCache', () => {
  it('returns cached result within TTL', async () => {
    let calls = 0
    const counting: ObsidianAdapter = {
      id: 'counting',
      async ping() { return true },
      async search() {
        calls += 1
        return [{ path: 'x', title: 'x', snippet: '', score: 1, matchedBy: 'fulltext' as const }]
      },
      async resolveWikilink() { return null },
      async backlinksOf() { return [] },
      async tagQuery() { return [] },
    }
    const cached = withCache(counting, { ttlSeconds: 60 })
    await cached.search('q', { limit: 1 })
    await cached.search('q', { limit: 1 })
    await cached.search('q', { limit: 1 })
    expect(calls).toBe(1)
  })

  it('does NOT leak between argument variants', async () => {
    let calls = 0
    const counting: ObsidianAdapter = {
      id: 'counting',
      async ping() { return true },
      async search(query) {
        calls += 1
        return [{ path: query, title: query, snippet: '', score: 1, matchedBy: 'fulltext' as const }]
      },
      async resolveWikilink() { return null },
      async backlinksOf() { return [] },
      async tagQuery() { return [] },
    }
    const cached = withCache(counting)
    await cached.search('a')
    await cached.search('b')
    expect(calls).toBe(2)
  })

  it('evicts the LRU entry when maxEntries is reached', async () => {
    let calls = 0
    const counting: ObsidianAdapter = {
      id: 'counting',
      async ping() { return true },
      async search(query) {
        calls += 1
        return [{ path: query, title: query, snippet: '', score: 1, matchedBy: 'fulltext' as const }]
      },
      async resolveWikilink() { return null },
      async backlinksOf() { return [] },
      async tagQuery() { return [] },
    }
    const cached = withCache(counting, { maxEntries: 2, ttlSeconds: 60 })

    await cached.search('a') // calls=1
    await cached.search('b') // calls=2
    await cached.search('c') // calls=3, evicts 'a' (oldest)
    expect(calls).toBe(3)

    // 'b' and 'c' still cached; 'a' evicted → triggers a fresh call.
    await cached.search('b')
    await cached.search('c')
    expect(calls).toBe(3)

    await cached.search('a') // re-fetch
    expect(calls).toBe(4)
  })

  it('refreshes recency on cache hit (true LRU semantics)', async () => {
    let calls = 0
    const counting: ObsidianAdapter = {
      id: 'counting',
      async ping() { return true },
      async search(query) {
        calls += 1
        return [{ path: query, title: query, snippet: '', score: 1, matchedBy: 'fulltext' as const }]
      },
      async resolveWikilink() { return null },
      async backlinksOf() { return [] },
      async tagQuery() { return [] },
    }
    const cached = withCache(counting, { maxEntries: 2, ttlSeconds: 60 })

    await cached.search('a')   // [a]
    await cached.search('b')   // [a, b]
    await cached.search('a')   // hit; [b, a]  ← 'a' becomes most-recent
    await cached.search('c')   // [a, c]; 'b' evicted

    expect(calls).toBe(3) // a once, b once, c once

    await cached.search('a') // still cached
    await cached.search('b') // re-fetched
    expect(calls).toBe(4)
  })
})

describe('MemoryStore + Obsidian source', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('retrieve({strategy:"multi"}) includes Obsidian hits when adapter is wired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-obs-'))
    cleanup.push(root)
    await mkdir(join(root, 'gks'), { recursive: true })
    await cp(FIXTURES, join(root, 'gks'), { recursive: true })

    const obsidian = createMockObsidianAdapter(sampleVault())
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      obsidian,
      reranker: { enabled: false },
    })
    await store.init()

    const res = await recall(store, 'planning', { strategy: 'multi', topK: 5, scoreThreshold: -1 })
    const obsidianHits = res.hits.filter((h) => h.source === 'obsidian')
    expect(obsidianHits.length).toBeGreaterThan(0)
    expect(obsidianHits.some((h) => h.title === 'Cortex')).toBe(true)
  })

  it('retrieve({strategy:"obsidian"}) routes only to Obsidian', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-obs-'))
    cleanup.push(root)
    const obsidian = createMockObsidianAdapter(sampleVault())
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      obsidian,
      reranker: { enabled: false },
    })
    await store.init()

    const res = await recall(store, 'motor', { strategy: 'obsidian', topK: 5 })
    expect(res.hits.every((h) => h.source === 'obsidian')).toBe(true)
  })

  it('omitting the adapter leaves obsidian as a no-op (back-compat)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-obs-'))
    cleanup.push(root)
    const store = new MemoryStore({ root, embedder: mockEmbedder(32), reranker: { enabled: false } })
    await store.init()
    const res = await recall(store, 'anything', { strategy: 'obsidian', topK: 5 })
    expect(res.hits).toEqual([])
  })
})
