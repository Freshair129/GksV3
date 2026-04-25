/**
 * CostTracker — accumulates token usage + USD spend per (provider, model).
 *
 * Scope: per-MemoryStore-instance. Typical pattern is one tracker per
 * session: callers `reset()` at session start, `summary()` at session
 * end (the result lands in session.json via endSession).
 *
 * Wiring: each network client calls `record({...})` once per request.
 *   - Anthropic: usage from response.usage.{input_tokens, output_tokens}
 *   - OpenAI:    usage from response.usage.total_tokens (input only)
 *   - Ollama:    estimated from input length (no usage reported)
 *   - Rerank:    estimated from input length
 *
 * The tracker also emits OTel histograms / counters via the telemetry
 * façade so dashboards see per-tenant spend without additional plumbing.
 */

import {
  DEFAULT_PRICING,
  estimateTokens,
  priceKey,
  rateUsd,
  type ModelPricing,
  type PricingKey,
} from './pricing.js'
import { incrementCounter, recordHistogram } from './telemetry.js'
import { createLogger } from './logger.js'

const log = createLogger('cost')

export interface CostRecord {
  provider: string
  model: string
  /** Always set; estimated when the provider doesn't report. */
  inputTokens: number
  /** 0 for embedders / rerankers. */
  outputTokens?: number
  /** Optional explicit cost override; otherwise computed from pricing table. */
  usd?: number
  /** Free-form (tenant_id, session_id, etc.) — surfaced in OTel labels. */
  attrs?: Record<string, string>
}

export interface ProviderTotal {
  provider: string
  model: string
  calls: number
  input_tokens: number
  output_tokens: number
  usd: number
}

export interface CostSummary {
  /** Per (provider, model) breakdown. */
  byModel: ProviderTotal[]
  /** Sum across everything. */
  total: {
    calls: number
    input_tokens: number
    output_tokens: number
    usd: number
  }
}

export interface CostTrackerOptions {
  /** Override / extend the default pricing table. Merged on top of DEFAULT_PRICING. */
  pricing?: Partial<Record<PricingKey, ModelPricing>>
  /** When true, every record() also emits gks.cost.* OTel metrics. Default true. */
  emitMetrics?: boolean
}

interface BucketRow {
  calls: number
  input_tokens: number
  output_tokens: number
  usd: number
}

export class CostTracker {
  private buckets = new Map<PricingKey, BucketRow>()
  private readonly pricing: Partial<Record<PricingKey, ModelPricing>>
  private readonly emitMetrics: boolean

  constructor(opts: CostTrackerOptions = {}) {
    this.pricing = { ...DEFAULT_PRICING, ...(opts.pricing ?? {}) }
    this.emitMetrics = opts.emitMetrics !== false
  }

  /** Record a single usage event. Called from embedder/LLM/rerank clients. */
  record(args: CostRecord): void {
    const key = priceKey(args.provider, args.model)
    const rate = this.pricing[key]
    const inputTokens = Math.max(0, Math.floor(args.inputTokens))
    const outputTokens = Math.max(0, Math.floor(args.outputTokens ?? 0))

    let usd = args.usd
    if (usd === undefined) {
      if (!rate) {
        log.debug('cost: no pricing for model — recording 0 usd', {
          provider: args.provider,
          model: args.model,
        })
      }
      usd = rate
        ? rateUsd(inputTokens, rate.inputPerMTok) + rateUsd(outputTokens, rate.outputPerMTok)
        : 0
    }

    const existing = this.buckets.get(key) ?? {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      usd: 0,
    }
    existing.calls += 1
    existing.input_tokens += inputTokens
    existing.output_tokens += outputTokens
    existing.usd += usd
    this.buckets.set(key, existing)

    if (this.emitMetrics) {
      const labels = {
        provider: args.provider,
        model: args.model,
        ...(args.attrs ?? {}),
      }
      incrementCounter('gks.cost.tokens_in', inputTokens, labels)
      if (outputTokens > 0) {
        incrementCounter('gks.cost.tokens_out', outputTokens, labels)
      }
      recordHistogram('gks.cost.usd', usd, labels)
    }
  }

  /** Snapshot of current totals, broken down + summed. */
  summary(): CostSummary {
    const byModel: ProviderTotal[] = []
    let totalCalls = 0
    let totalIn = 0
    let totalOut = 0
    let totalUsd = 0
    for (const [key, row] of this.buckets) {
      const [provider, ...modelParts] = key.split(':')
      byModel.push({
        provider: provider!,
        model: modelParts.join(':'),
        calls: row.calls,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        usd: round6(row.usd),
      })
      totalCalls += row.calls
      totalIn += row.input_tokens
      totalOut += row.output_tokens
      totalUsd += row.usd
    }
    byModel.sort((a, b) => b.usd - a.usd)
    return {
      byModel,
      total: {
        calls: totalCalls,
        input_tokens: totalIn,
        output_tokens: totalOut,
        usd: round6(totalUsd),
      },
    }
  }

  /** Reset all counters. Caller does this at session start when scoping by session. */
  reset(): void {
    this.buckets.clear()
  }
}

/** Re-export so consumers can build their own pricing tables. */
export { DEFAULT_PRICING, estimateTokens }
export type { ModelPricing, PricingKey }

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}
