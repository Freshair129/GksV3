import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createReranker, rerank } from '../../src/memory/rerank.js'
import { MemoryStore, type MemoryStoreOptions } from '../../src/memory/index.js'
import { retain, recall } from '../../src/memory/api.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

describe('lexical reranker (BM25-lite)', () => {
  const r = createReranker({ backend: 'lexical' })

  it('scores an exact match higher than an unrelated doc', async () => {
    const scores = await r.score('tri-brain architecture', [
      'The tri-brain architecture has three cognitive modules.',
      'Quantum mechanics is unrelated to memory systems.',
    ])
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
  })

  it('returns zeros on empty query', async () => {
    const scores = await r.score('', ['one', 'two', 'three'])
    expect(scores).toEqual([0, 0, 0])
  })

  it('length-normalizes (long docs not unfairly boosted)', async () => {
    const scores = await r.score('paris', [
      'paris', // short, exact
      'paris ' + 'lorem '.repeat(100), // long, diluted
    ])
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
  })
})

describe('rerank() blending', () => {
  const r = createReranker({ backend: 'lexical' })

  it('reorders hits when reranker disagrees with first-pass', async () => {
    const hits = [
      { id: 'a', text: 'unrelated text about physics', score: 0.9 }, // first-pass "winner"
      { id: 'b', text: 'the cat sat on the mat', score: 0.4 },
      { id: 'c', text: 'the dog chased a ball', score: 0.3 },
    ]
    const reranked = await rerank(
      r,
      {
        query: 'cat mat',
        hits,
        getText: (h) => h.text,
        getScore: (h) => h.score,
        withScore: (h, s) => ({ ...h, score: s }),
      },
      { alpha: 1.0, normalize: true, limit: 20 }, // alpha=1 → pure reranker
    )
    expect(reranked[0]!.id).toBe('b')
  })

  it('honors limit (tail kept verbatim)', async () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, text: `text ${i}`, score: 0.5 }))
    const reranked = await rerank(
      r,
      {
        query: 'text 3',
        hits,
        getText: (h) => h.text,
        getScore: (h) => h.score,
        withScore: (h, s) => ({ ...h, score: s }),
      },
      { alpha: 0.5, normalize: true, limit: 2 },
    )
    expect(reranked).toHaveLength(5)
    // The untouched tail [indexes 2..4] should still be present.
    for (let i = 2; i < 5; i++) {
      expect(reranked.some((h) => h.id === `h${i}`)).toBe(true)
    }
  })

  it('falls back to first-pass when reranker returns wrong shape', async () => {
    const broken = {
      name: 'broken',
      async score(_q: string, _texts: readonly string[]) {
        return [0.5] // wrong length
      },
    }
    const hits = [
      { id: 'a', text: 'x', score: 0.3 },
      { id: 'b', text: 'y', score: 0.9 },
    ]
    const reranked = await rerank(
      broken,
      {
        query: 'q',
        hits,
        getText: (h) => h.text,
        getScore: (h) => h.score,
        withScore: (h, s) => ({ ...h, score: s }),
      },
      { alpha: 1.0, normalize: true, limit: 10 },
    )
    expect(reranked).toEqual(hits)
  })
})

describe('MemoryStore + reranker integration', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  async function withStore(rerankerOpts?: MemoryStoreOptions['reranker']) {
    const root = await mkdtemp(join(tmpdir(), 'gks-rerank-'))
    cleanup.push(root)
    await mkdir(join(root, 'gks'), { recursive: true })
    await cp(FIXTURES, join(root, 'gks'), { recursive: true })
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(64),
      ...(rerankerOpts ? { reranker: rerankerOpts } : {}),
    })
    await store.init()
    return store
  }

  it('reranker improves ordering when mock embedder ranks wrong', async () => {
    const store = await withStore({ backend: 'lexical', alpha: 1.0 })
    await retain(store, { content: 'the capital of France is Paris', metadata: { path: 'a.md' } })
    await retain(store, { content: 'random filler about whales and oceans', metadata: { path: 'b.md' } })
    await retain(store, { content: 'Paris is a city in France', metadata: { path: 'c.md' } })

    const res = await recall(store, 'Paris France capital', { strategy: 'vector', topK: 3, scoreThreshold: -1 })
    expect(res.hits.length).toBeGreaterThan(0)
    // Top hit should contain "Paris" — BM25 guarantees it.
    expect(res.hits[0]!.snippet.toLowerCase()).toContain('paris')
  })

  it('can be fully disabled', async () => {
    const store = await withStore({ enabled: false })
    await retain(store, { content: 'some content', metadata: { path: 'x.md' } })
    const res = await recall(store, 'some content', { strategy: 'vector', topK: 1, scoreThreshold: -1 })
    expect(res.hits).toHaveLength(1)
  })
})
