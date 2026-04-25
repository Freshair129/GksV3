/**
 * retry.ts unit tests — focus on policy, not timing. Backoff durations are
 * verified deterministically by stubbing Math.random; we don't actually
 * sleep for thousands of milliseconds in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  withRetry,
  computeBackoff,
  defaultIsRetryable,
  RetryAbortError,
} from '../../src/lib/retry.js'

describe('computeBackoff', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => vi.restoreAllMocks())

  it('grows exponentially up to the cap', () => {
    expect(computeBackoff(1, 200, 5000)).toBe(100) // 0.5 * 200
    expect(computeBackoff(2, 200, 5000)).toBe(200) // 0.5 * 400
    expect(computeBackoff(3, 200, 5000)).toBe(400) // 0.5 * 800
    expect(computeBackoff(4, 200, 5000)).toBe(800)
    expect(computeBackoff(10, 200, 5000)).toBe(2500) // capped at 0.5 * 5000
  })
})

describe('defaultIsRetryable', () => {
  it('retries network-level codes', () => {
    expect(defaultIsRetryable({ code: 'ECONNRESET' }, 1)).toBe(true)
    expect(defaultIsRetryable({ code: 'ETIMEDOUT' }, 1)).toBe(true)
    expect(defaultIsRetryable({ code: 'EAI_AGAIN' }, 1)).toBe(true)
  })
  it('retries 408 / 429 / 5xx HTTP status messages', () => {
    expect(defaultIsRetryable(new Error('ollama embed 503: down'), 1)).toBe(true)
    expect(defaultIsRetryable(new Error('openai embed 429: rate limited'), 1)).toBe(true)
    expect(defaultIsRetryable(new Error('408 timeout'), 1)).toBe(true)
  })
  it('does NOT retry 4xx (except 408/429)', () => {
    expect(defaultIsRetryable(new Error('openai 400: bad request'), 1)).toBe(false)
    expect(defaultIsRetryable(new Error('anthropic 401 unauthorized'), 1)).toBe(false)
    expect(defaultIsRetryable(new Error('rerank http 422: invalid'), 1)).toBe(false)
  })
  it('retries generic timeout / aborted messages', () => {
    expect(defaultIsRetryable(new Error('socket hang up'), 1)).toBe(true)
    expect(defaultIsRetryable(new Error('fetch failed'), 1)).toBe(true)
    expect(defaultIsRetryable(new Error('connection aborted'), 1)).toBe(true)
  })
  it('does NOT retry plain application errors', () => {
    expect(defaultIsRetryable(new Error('schema mismatch'), 1)).toBe(false)
  })
})

describe('withRetry', () => {
  beforeEach(() => {
    // Make sleep effectively instant.
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns the first successful value', async () => {
    const fn = vi.fn(async () => 'ok')
    const out = await withRetry(fn)
    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable failures up to the budget', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('ollama embed 503: blip')
      return 'ok'
    })
    const out = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 0 })
    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('rethrows the last error after exhausting attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ollama 503: still down')
    })
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toThrow(
      /still down/,
    )
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('short-circuits on a non-retryable error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('openai 400: bad input')
    })
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 0 })).rejects.toThrow(/400/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('honors a custom isRetryable predicate', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      throw new Error('always')
    })
    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 0,
        isRetryable: (_err, attempt) => attempt < 2,
      }),
    ).rejects.toThrow(/always/)
    // First call throws (attempt=1 → predicate true → retry), second call
    // throws (attempt=2 → predicate false → bail). Total 2 calls.
    expect(calls).toBe(2)
  })

  it('throws RetryAbortError when signal aborts mid-flight', async () => {
    const ctrl = new AbortController()
    const fn = vi.fn(async (attempt: number) => {
      if (attempt === 1) throw new Error('ollama 503: blip')
      // Abort right before the next attempt would run.
      ctrl.abort('test')
      throw new Error('still 503')
    })
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(RetryAbortError)
  })
})
