import { describe, it, expect } from 'vitest'
import { cosine, l2Normalize, topK } from '../../src/memory/vector/similarity.js'
import type { VectorDoc } from '../../src/memory/types.js'

describe('cosine', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })

  it('returns -1 for opposite vectors', () => {
    expect(cosine([1, 2], [-1, -2])).toBeCloseTo(-1, 10)
  })

  it('returns 0 when either vector is all zeros', () => {
    expect(cosine([0, 0], [1, 2])).toBe(0)
    expect(cosine([1, 2], [0, 0])).toBe(0)
  })

  it('throws on dimension mismatch', () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dim mismatch/)
  })
})

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    const v = l2Normalize([3, 4])
    expect(v[0]! * v[0]! + v[1]! * v[1]!).toBeCloseTo(1, 10)
  })
})

describe('topK', () => {
  const makeDoc = (id: string, v: number[]): VectorDoc => ({
    id,
    source: 'test',
    chunk_id: id,
    text: `doc ${id}`,
    vector: v,
    metadata: { path: `${id}.md` },
  })

  it('returns the k closest docs sorted by score desc', () => {
    const docs = [
      makeDoc('a', [1, 0, 0]),
      makeDoc('b', [0.9, 0.1, 0]),
      makeDoc('c', [0, 1, 0]),
      makeDoc('d', [-1, 0, 0]),
    ]
    const hits = topK([1, 0, 0], docs, { topK: 2 })
    expect(hits).toHaveLength(2)
    expect(hits[0]!.doc.id).toBe('a')
    expect(hits[1]!.doc.id).toBe('b')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('respects scoreThreshold', () => {
    const docs = [
      makeDoc('a', [1, 0, 0]),
      makeDoc('b', [0, 1, 0]),
    ]
    const hits = topK([1, 0, 0], docs, { topK: 5, scoreThreshold: 0.5 })
    expect(hits.map((h) => h.doc.id)).toEqual(['a'])
  })

  it('applies metadata filters', () => {
    const docs: VectorDoc[] = [
      { ...makeDoc('a', [1, 0, 0]), metadata: { path: 'a.md', status: 'stable' } },
      { ...makeDoc('b', [0.9, 0.1, 0]), metadata: { path: 'b.md', status: 'draft' } },
    ]
    const hits = topK([1, 0, 0], docs, { topK: 5, filter: { status: 'stable' } })
    expect(hits.map((h) => h.doc.id)).toEqual(['a'])
  })
})
