import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  createReranker,
  rerank,
  type CrossEncoderLoader,
} from '../../src/memory/rerank.js'
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

describe('transformers reranker (cross-encoder via @huggingface/transformers)', () => {
  /**
   * Tests use an injected loader so we never download the real ~600MB model
   * in CI. The mock returns one logit per doc — magnitude controlled by the
   * test so we can assert ordering deterministically.
   */
  function makeLoader(scoreFn: (q: string, t: string) => number): {
    loader: CrossEncoderLoader
    calls: { model: string; queries: string[]; texts: string[] }[]
  } {
    const calls: { model: string; queries: string[]; texts: string[] }[] = []
    const loader: CrossEncoderLoader = async (model: string) => {
      return async (q: string, texts: readonly string[]) => {
        calls.push({ model, queries: [q], texts: [...texts] })
        return texts.map((t) => scoreFn(q, t))
      }
    }
    return { loader, calls }
  }

  it('lazy-loads the model only on first .score() call', async () => {
    const { loader, calls } = makeLoader(() => 1)
    const r = createReranker({ backend: 'transformers', crossEncoderLoader: loader })
    expect(calls).toHaveLength(0) // construction does not load
    await r.score('q', ['a', 'b'])
    expect(calls).toHaveLength(1)
    await r.score('q2', ['c'])
    expect(calls).toHaveLength(2)
  })

  it('uses the configured model id (defaults to bge-reranker-v2-m3)', async () => {
    const { loader, calls } = makeLoader(() => 0)
    const def = createReranker({ backend: 'transformers', crossEncoderLoader: loader })
    expect(def.name).toBe('transformers:Xenova/bge-reranker-v2-m3')
    await def.score('q', ['x'])
    expect(calls[0]!.model).toBe('Xenova/bge-reranker-v2-m3')

    const custom = createReranker({
      backend: 'transformers',
      model: 'Xenova/bge-reranker-base',
      crossEncoderLoader: loader,
    })
    expect(custom.name).toBe('transformers:Xenova/bge-reranker-base')
    await custom.score('q', ['x'])
    expect(calls[1]!.model).toBe('Xenova/bge-reranker-base')
  })

  it('returns one score per document (mock cross-encoder shape)', async () => {
    // Score = number of shared lowercased characters — proxy for "relevance".
    const { loader } = makeLoader((q, t) => {
      const qs = new Set(q.toLowerCase())
      let n = 0
      for (const c of t.toLowerCase()) if (qs.has(c)) n++
      return n
    })
    const r = createReranker({ backend: 'transformers', crossEncoderLoader: loader })
    const scores = await r.score('paris', [
      'paris is a city',
      'totally unrelated zzzz',
      'paris france capital',
    ])
    expect(scores).toHaveLength(3)
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
    expect(scores[2]!).toBeGreaterThan(scores[1]!)
  })

  it('returns [] on empty input without invoking the model', async () => {
    const { loader, calls } = makeLoader(() => 1)
    const r = createReranker({ backend: 'transformers', crossEncoderLoader: loader })
    const out = await r.score('q', [])
    expect(out).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('throws if loader returns wrong score count', async () => {
    const badLoader: CrossEncoderLoader = async () => async () => [0.5] // always 1 score
    const r = createReranker({ backend: 'transformers', crossEncoderLoader: badLoader })
    await expect(r.score('q', ['a', 'b', 'c'])).rejects.toThrow(/expected 3 scores, got 1/)
  })

  it('plugs into rerank() and reorders hits when the cross-encoder disagrees', async () => {
    // First-pass thinks doc 'a' is best; cross-encoder strongly prefers 'b'.
    const { loader } = makeLoader((q, t) => (t.includes(q) ? 5 : 0))
    const r = createReranker({ backend: 'transformers', crossEncoderLoader: loader })
    const hits = [
      { id: 'a', text: 'completely unrelated', score: 0.95 },
      { id: 'b', text: 'paris', score: 0.4 },
      { id: 'c', text: 'london', score: 0.3 },
    ]
    const reranked = await rerank(
      r,
      {
        query: 'paris',
        hits,
        getText: (h) => h.text,
        getScore: (h) => h.score,
        withScore: (h, s) => ({ ...h, score: s }),
      },
      { alpha: 1.0, normalize: true, limit: 20 },
    )
    expect(reranked[0]!.id).toBe('b')
  })
})
