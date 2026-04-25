import { describe, it, expect } from 'vitest'
import {
  CostTracker,
  estimateTokens,
} from '../../src/lib/cost-tracker.js'
import { rateUsd } from '../../src/lib/pricing.js'

describe('estimateTokens', () => {
  it('returns 0 on empty input', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens([])).toBe(0)
  })

  it('roughly approximates 3.5 chars per token', () => {
    expect(estimateTokens('1234567')).toBe(2)
    expect(estimateTokens('1234567890')).toBe(3)
  })

  it('sums across array inputs', () => {
    expect(estimateTokens(['hello', 'world'])).toBe(estimateTokens('helloworld'))
  })
})

describe('rateUsd', () => {
  it('linear with token count', () => {
    // 1M tokens at $3/1M = $3
    expect(rateUsd(1_000_000, 3)).toBe(3)
    expect(rateUsd(500_000, 3)).toBe(1.5)
  })
})

describe('CostTracker', () => {
  it('records and totals across multiple providers', () => {
    const t = new CostTracker({ emitMetrics: false })

    t.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 200,
    })
    t.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 500,
      outputTokens: 50,
    })
    t.record({
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputTokens: 10_000,
    })

    const s = t.summary()
    expect(s.byModel).toHaveLength(2)
    const anthro = s.byModel.find((b) => b.provider === 'anthropic')!
    expect(anthro.calls).toBe(2)
    expect(anthro.input_tokens).toBe(1500)
    expect(anthro.output_tokens).toBe(250)
    // 1500 in × $3/1M + 250 out × $15/1M = 0.0045 + 0.00375 = 0.00825
    expect(anthro.usd).toBeCloseTo(0.00825, 6)

    expect(s.total.calls).toBe(3)
    expect(s.total.input_tokens).toBe(11_500)
    expect(s.total.output_tokens).toBe(250)
  })

  it('orders byModel by USD descending', () => {
    const t = new CostTracker({ emitMetrics: false })
    t.record({ provider: 'openai', model: 'text-embedding-3-small', inputTokens: 1_000_000 })
    t.record({ provider: 'anthropic', model: 'claude-opus-4-7', inputTokens: 100, outputTokens: 100 })

    const s = t.summary()
    // 100 input × $15/1M + 100 output × $75/1M = 0.0015 + 0.0075 = 0.009
    // 1M input × $0.02/1M = 0.02 — openai larger
    expect(s.byModel[0]!.provider).toBe('openai')
  })

  it('honors a usd override (no pricing lookup)', () => {
    const t = new CostTracker({ emitMetrics: false })
    t.record({
      provider: 'unknown',
      model: 'unknown-model',
      inputTokens: 1000,
      usd: 0.42,
    })
    expect(t.summary().total.usd).toBe(0.42)
  })

  it('returns 0 USD when no pricing entry and no override', () => {
    const t = new CostTracker({ emitMetrics: false })
    t.record({ provider: 'random', model: 'xyz', inputTokens: 1_000_000 })
    expect(t.summary().total.usd).toBe(0)
  })

  it('user-provided pricing overrides DEFAULT_PRICING', () => {
    const t = new CostTracker({
      emitMetrics: false,
      pricing: {
        'openai:text-embedding-3-small': { inputPerMTok: 999, outputPerMTok: 0 },
      },
    })
    t.record({ provider: 'openai', model: 'text-embedding-3-small', inputTokens: 1_000_000 })
    expect(t.summary().total.usd).toBe(999)
  })

  it('reset() clears all buckets', () => {
    const t = new CostTracker({ emitMetrics: false })
    t.record({ provider: 'p', model: 'm', inputTokens: 100 })
    expect(t.summary().total.calls).toBe(1)
    t.reset()
    expect(t.summary().total.calls).toBe(0)
    expect(t.summary().byModel).toHaveLength(0)
  })

  it('clamps negative tokens to 0', () => {
    const t = new CostTracker({ emitMetrics: false })
    t.record({ provider: 'p', model: 'm', inputTokens: -100, outputTokens: -5 })
    expect(t.summary().total.input_tokens).toBe(0)
    expect(t.summary().total.output_tokens).toBe(0)
  })
})
