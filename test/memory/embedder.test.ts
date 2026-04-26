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

describe('createEmbedder — Ollama with circuit breaker', () => {
  // We don't have a real Ollama in CI; stub global fetch to return 503 then
  // verify the breaker trips after the configured threshold.
  it('trips the breaker after sustained 5xx and short-circuits subsequent calls', async () => {
    const calls: number[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown) => {
      calls.push(Date.now())
      return new Response('upstream down', { status: 503 })
    }) as typeof fetch

    try {
      const { createEmbedder } = await import('../../src/memory/vector/embedder.js')
      const { CircuitBreakerOpenError } = await import('../../src/lib/circuit-breaker.js')

      const e = await createEmbedder({
        forceProvider: 'ollama',
        ollamaBaseUrl: 'http://nonexistent:11434',
        retryMaxAttempts: 1, // no retries — one shot per call
        breaker: { failureThreshold: 3, cooldownMs: 60_000 },
      })

      // Three failing calls trip the breaker.
      for (let i = 0; i < 3; i++) {
        await expect(e.embed('hi')).rejects.toThrow(/503/)
      }
      const callsAfterTrip = calls.length

      // Fourth call short-circuits — fetch is NOT invoked.
      await expect(e.embed('hi')).rejects.toBeInstanceOf(CircuitBreakerOpenError)
      expect(calls.length).toBe(callsAfterTrip)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does NOT trip the breaker on 401 (auth errors are config issues)', async () => {
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      return new Response('forbidden', { status: 401 })
    }) as typeof fetch

    try {
      const { createEmbedder } = await import('../../src/memory/vector/embedder.js')
      const e = await createEmbedder({
        forceProvider: 'ollama',
        ollamaBaseUrl: 'http://nonexistent:11434',
        retryMaxAttempts: 1,
        breaker: { failureThreshold: 2, cooldownMs: 60_000 },
      })

      // 5 consecutive 401s — would trip a default breaker but NOT ours
      // because defaultEmbedderFailure ignores 4xx (except 408/429).
      for (let i = 0; i < 5; i++) {
        await expect(e.embed('hi')).rejects.toThrow(/401/)
      }
      // All 5 calls hit the network — the breaker stayed closed.
      expect(calls).toBe(5)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
