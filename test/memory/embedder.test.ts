import { describe, it, expect } from 'vitest'
import { createEmbedder, mockEmbedder } from '../../src/memory/vector/embedder.js'

describe('mockEmbedder', () => {
  it('produces L2-normalized vectors of the requested dimension', async () => {
    const e = mockEmbedder(128)
    const v = await e.embed('hello world')
    expect(v).toHaveLength(128)
    let n = 0
    for (const x of v) n += x * x
    expect(Math.sqrt(n)).toBeCloseTo(1, 6)
  })

  it('is deterministic for the same input', async () => {
    const e = mockEmbedder(64)
    const a = await e.embed('deterministic test')
    const b = await e.embed('deterministic test')
    expect(a).toEqual(b)
  })

  it('differs for different inputs', async () => {
    const e = mockEmbedder(64)
    const a = await e.embed('apple')
    const b = await e.embed('orange')
    expect(a).not.toEqual(b)
  })

  it('embedBatch matches embed for each element', async () => {
    const e = mockEmbedder(32)
    const batch = await e.embedBatch(['one', 'two', 'three'])
    const one = await e.embed('one')
    expect(batch[0]).toEqual(one)
    expect(batch).toHaveLength(3)
  })
})

describe('createEmbedder', () => {
  it('returns a mock embedder when forced', async () => {
    const e = await createEmbedder({ forceProvider: 'mock', mockDimension: 16 })
    expect(e.provider).toBe('mock')
    expect(e.dimension).toBe(16)
  })
})
