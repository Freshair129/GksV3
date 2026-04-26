import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VectorStore } from '../../src/memory/vector/index.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'

async function tmpStore(dim = 32) {
  const dir = await mkdtemp(join(tmpdir(), 'gks-vec-'))
  const embedder = mockEmbedder(dim)
  const store = new VectorStore({
    path: join(dir, 'atomic.jsonl'),
    embedder,
    name: 'atomic',
  })
  await store.load()
  return { store, dir }
}

describe('VectorStore', () => {
  let cleanup: string[] = []

  beforeEach(() => {
    cleanup = []
  })

  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('add() embeds, stores, and is searchable', async () => {
    const { store, dir } = await tmpStore()
    cleanup.push(dir)

    await store.add('the cat sat on the mat', { path: 'a.md', status: 'stable' })
    await store.add('the dog chased the ball', { path: 'b.md', status: 'stable' })
    await store.add('completely unrelated content about quantum physics', {
      path: 'c.md',
      status: 'draft',
    })

    // Mock embedder is SHA256-based (not semantic) — search by exact text to
    // get a score of 1.0 against the matching doc. Threshold -1 keeps the
    // remaining docs in the ranking so topK:2 returns 2 hits.
    const hits = await store.search('the cat sat on the mat', { topK: 2, scoreThreshold: -1 })
    expect(hits).toHaveLength(2)
    expect(hits[0]!.doc.text).toBe('the cat sat on the mat')
    expect(hits[0]!.score).toBeCloseTo(1, 6)
  })

  it('persists across reload', async () => {
    const { store, dir } = await tmpStore()
    cleanup.push(dir)

    await store.add('hello world', { path: 'h.md' })
    await store.add('goodbye world', { path: 'g.md' })

    const reopened = new VectorStore({
      path: join(dir, 'atomic.jsonl'),
      embedder: mockEmbedder(32),
      name: 'atomic',
    })
    await reopened.load()
    expect(reopened.size()).toBe(2)
  })

  it('manifest tracks doc count and embedder model', async () => {
    const { store, dir } = await tmpStore()
    cleanup.push(dir)

    await store.add('one', { path: '1.md' })
    await store.add('two', { path: '2.md' })

    const m = store.getManifest()
    expect(m.doc_count).toBe(2)
    expect(m.embedder_model).toMatch(/^mock-sha256-d\d+/)
    expect(m.dimension).toBe(32)
  })

  it('addBatch() adds all items and returns them', async () => {
    const { store, dir } = await tmpStore()
    cleanup.push(dir)

    const out = await store.addBatch([
      { text: 'alpha', metadata: { path: 'a.md' } },
      { text: 'beta', metadata: { path: 'b.md' } },
      { text: 'gamma', metadata: { path: 'g.md' } },
    ])
    expect(out).toHaveLength(3)
    expect(store.size()).toBe(3)
  })

  it('metadata filter narrows results', async () => {
    const { store, dir } = await tmpStore()
    cleanup.push(dir)

    await store.add('important stable fact', { path: 's.md', status: 'stable' })
    await store.add('tentative draft note', { path: 'd.md', status: 'draft' })

    const hits = await store.search('fact', {
      topK: 5,
      filter: { status: 'stable' },
      scoreThreshold: -1, // keep everything for this assertion
    })
    expect(hits.every((h) => h.doc.metadata['status'] === 'stable')).toBe(true)
  })

  it('clear() empties the store', async () => {
    const { store, dir } = await tmpStore()
    cleanup.push(dir)
    await store.add('x', { path: 'x.md' })
    expect(store.size()).toBe(1)
    await store.clear()
    expect(store.size()).toBe(0)
  })
})
