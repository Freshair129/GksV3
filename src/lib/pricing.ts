/**
 * Pricing table for known model providers.
 *
 * Rates are USD per 1M tokens (input / output). Numbers shift; callers can
 * override per-instance via CostTracker constructor. Keeping defaults in
 * the codebase means typical setups get cost visibility without configuration.
 *
 * Sources (as of 2026-04-25 — verify before billing on these numbers):
 *   - Anthropic:  https://www.anthropic.com/pricing
 *   - OpenAI:     https://openai.com/api/pricing/
 *   - Ollama:     local — no $ charge (we still track tokens for capacity planning)
 *   - HF TEI:     self-hosted — no $ charge
 *
 * Token accounting note: rerank requests don't have a meaningful "output
 * tokens" concept; we record input tokens only. LLM calls (Anthropic
 * Messages) report both. Embedder calls are input-only.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number
  /** USD per 1M output tokens. 0 for embedders / rerankers. */
  outputPerMTok: number
}

export type PricingKey = `${string}:${string}`

/** Default pricing table. Update as providers move; users override per-instance. */
export const DEFAULT_PRICING: Record<PricingKey, ModelPricing> = {
  // ── Anthropic (Messages API) ────────────────────────────────────────────
  'anthropic:claude-opus-4-7': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  'anthropic:claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'anthropic:claude-haiku-4-5-20251001': { inputPerMTok: 1.0, outputPerMTok: 5.0 },

  // ── OpenAI Embeddings ───────────────────────────────────────────────────
  'openai:text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0 },
  'openai:text-embedding-3-large': { inputPerMTok: 0.13, outputPerMTok: 0 },

  // ── Self-hosted (no charge; tokens tracked for capacity / quotas) ───────
  'ollama:bge-m3': { inputPerMTok: 0, outputPerMTok: 0 },
  'http:rerank': { inputPerMTok: 0, outputPerMTok: 0 },
  'mock:mock-sha256-d384': { inputPerMTok: 0, outputPerMTok: 0 },
}

export function priceKey(provider: string, model: string): PricingKey {
  return `${provider}:${model}`
}

/** Cost in USD given a token count and rate per 1M tokens. */
export function rateUsd(tokens: number, perMTok: number): number {
  return (tokens / 1_000_000) * perMTok
}

/**
 * Cheap heuristic for tokens when the provider doesn't return a usage report.
 * Roughly 4 chars per token for English; bumped slightly to catch Asian
 * scripts where the ratio is closer to 2-3 chars/token.
 */
export function estimateTokens(text: string | string[]): number {
  const total = Array.isArray(text) ? text.reduce((a, t) => a + t.length, 0) : text.length
  return Math.ceil(total / 3.5)
}
