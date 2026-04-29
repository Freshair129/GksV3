/**
 * Embedder — Ollama (bge-m3) primary, OpenAI (text-embedding-3-small) fallback.
 *
 * Contract from BLUEPRINT--memory §layers.vector.embedder:
 *   - primary:  ollama / bge-m3 / dim=1024
 *   - fallback: openai / text-embedding-3-small / dim=1536
 *
 * Selection policy:
 *   1. If GKS_EMBEDDER=mock → deterministic hash-based mock (for tests / offline CI).
 *   2. If GKS_EMBEDDER=openai OR Ollama ping fails → OpenAI (requires OPENAI_API_KEY).
 *   3. Otherwise → Ollama at OLLAMA_BASE_URL (default http://localhost:11434).
 *
 * The manifest (see ./manifest.ts) records {model, dimension} so that a re-embed
 * is forced if a rebuild ever changes provider — no silent dimension mismatches.
 */

import { createHash } from 'node:crypto'
import { createLogger } from '../../lib/logger.js'
import { createNomicEmbedder } from './embedder-nomic.js'
import { extractHttpStatus, withRetry } from '../../lib/retry.js'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitBreakerOptions,
} from '../../lib/circuit-breaker.js'
import { METRIC_NAMES, recordHistogram } from '../../lib/telemetry.js'
import type { CostTracker } from '../../lib/cost-tracker.js'
import { estimateTokens } from '../../lib/pricing.js'
import { redactSecrets, truncate } from '../../lib/text.js'

const log = createLogger('vector:embedder')

/**
 * Wrap an Embedder so each call also records usage to a CostTracker.
 * MemoryStore applies this wrapper when a tracker is configured. Keeps
 * the public Embedder interface untouched and avoids module-scoped state
 * (so multi-tenant deployments with one tracker per request stay safe).
 *
 * Token accounting policy:
 *   - openai: pulls usage from response — populated by openaiEmbedder
 *     via the closure variable `lastUsageTokens` it sets per call.
 *   - ollama / mock: no usage in response → estimate via heuristic
 *     (chars / 3.5).
 */
export function wrapEmbedderWithCostTracker(
  inner: Embedder,
  tracker: CostTracker,
  attrs: Record<string, string> = {},
): Embedder {
  return {
    provider: inner.provider,
    model: inner.model,
    get dimension() {
      return inner.dimension
    },
    async embed(text: string) {
      const v = await inner.embed(text)
      tracker.record({
        provider: inner.provider,
        model: inner.model,
        inputTokens: usageOrEstimate(inner, [text]),
        attrs,
      })
      return v
    },
    async embedBatch(texts: string[]) {
      const vectors = await inner.embedBatch(texts)
      tracker.record({
        provider: inner.provider,
        model: inner.model,
        inputTokens: usageOrEstimate(inner, texts),
        attrs,
      })
      return vectors
    },
  }
}

function usageOrEstimate(embedder: Embedder, texts: string[]): number {
  const reported = (embedder as { _lastUsageTokens?: number })._lastUsageTokens
  if (typeof reported === 'number' && reported > 0) {
    // Reset after use so the next call doesn't double-count.
    ;(embedder as { _lastUsageTokens?: number })._lastUsageTokens = 0
    return reported
  }
  return estimateTokens(texts)
}

export interface EmbedderInfo {
  provider: 'nomic' | 'ollama' | 'openai' | 'mock'
  model: string
  dimension: number
}

export interface Embedder extends EmbedderInfo {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

export interface EmbedderOptions {
  provider?: 'nomic' | 'ollama' | 'openai' | 'mock' | 'auto'
  ollamaBaseUrl?: string
  ollamaModel?: string
  openaiApiKey?: string
  openaiModel?: string
  openaiBaseUrl?: string
  mockDimension?: number
  /** For tests / pinned benchmarks — skip probing and force this provider. */
  forceProvider?: 'ollama' | 'openai' | 'mock'
  /**
   * Per-call retry budget for Ollama / OpenAI requests. See
   * src/lib/retry.ts. Default: 3 attempts, 200ms base, 5s max.
   */
  retryMaxAttempts?: number
  /**
   * Circuit breaker config wrapping the network embedders. Trips after
   * `failureThreshold` consecutive failures and short-circuits subsequent
   * calls for `cooldownMs`. Default: 5 failures / 30s cooldown.
   * Pass { enabled: false } to disable the breaker entirely (tests that
   * intentionally cycle through failures, for instance).
   */
  breaker?: CircuitBreakerOptions & { enabled?: boolean }
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL = 'bge-m3'
const DEFAULT_OLLAMA_DIM = 1024
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_DIM = 1536
const DEFAULT_MOCK_DIM = 384

export async function createEmbedder(opts: EmbedderOptions = {}): Promise<Embedder> {
  const forced =
    opts.forceProvider ??
    (process.env['GKS_EMBEDDER'] as EmbedderOptions['forceProvider'] | undefined)

  if (forced === 'mock') return mockEmbedder(opts.mockDimension ?? DEFAULT_MOCK_DIM)
  if (forced === 'openai') return openaiEmbedder(opts)
  if (forced === 'ollama') return ollamaEmbedder(opts)
  if (forced === 'nomic') return createNomicEmbedder()

  // Auto mode: nomic → Ollama → OpenAI → mock
  try {
    const e = createNomicEmbedder()
    // warm-up probe — triggers download on first run
    await e.embed('ping')
    log.info('embedder: nomic selected (local, Thai+English)')
    return e
  } catch (err) {
    log.warn('embedder: nomic unavailable, trying ollama', { err: String(err) })
  }

  const ollamaUrl = opts.ollamaBaseUrl ?? process.env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_URL
  if (await isOllamaAvailable(ollamaUrl)) {
    log.info('embedder: ollama selected', { url: ollamaUrl })
    return ollamaEmbedder(opts)
  }

  const apiKey = opts.openaiApiKey ?? process.env['OPENAI_API_KEY']
  if (apiKey) {
    log.info('embedder: openai selected')
    return openaiEmbedder({ ...opts, openaiApiKey: apiKey })
  }

  log.warn('embedder: no provider available, using deterministic mock (for tests only)')
  return mockEmbedder(opts.mockDimension ?? DEFAULT_MOCK_DIM)
}

// ───────────────────────────────────────────────────────── ollama

async function isOllamaAvailable(baseUrl: string, timeoutMs = 500): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

function ollamaEmbedder(opts: EmbedderOptions): Embedder {
  const baseUrl = opts.ollamaBaseUrl ?? process.env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_URL
  const model = opts.ollamaModel ?? process.env['OLLAMA_EMBED_MODEL'] ?? DEFAULT_OLLAMA_MODEL
  let dimension = DEFAULT_OLLAMA_DIM // updated from first response
  const breaker = makeBreaker(opts, 'ollama')
  const maxAttempts = opts.retryMaxAttempts ?? 3

  async function embedOne(text: string): Promise<number[]> {
    return runWithBreaker(
      breaker,
      () =>
        withRetry(
          async () => {
            const res = await fetch(`${baseUrl}/api/embeddings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model, prompt: text }),
            })
            if (!res.ok) {
              const body = await res.text().catch(() => '')
              throw new Error(`ollama embed ${res.status}: ${truncate(redactSecrets(body), 200)}`)
            }
            const data = (await res.json()) as { embedding?: number[] }
            if (!data.embedding || !Array.isArray(data.embedding)) {
              throw new Error('ollama: response missing `embedding`')
            }
            dimension = data.embedding.length
            return data.embedding
          },
          { label: 'ollama-embed', maxAttempts },
        ),
      { provider: 'ollama', model },
    )
  }

  return {
    provider: 'ollama',
    model,
    get dimension() {
      return dimension
    },
    embed: embedOne,
    // Ollama /api/embeddings is per-prompt; batch sequentially with bounded concurrency.
    embedBatch: async (texts: string[]) => boundedMap(texts, 4, embedOne),
  } as Embedder
}

// ───────────────────────────────────────────────────────── openai

function openaiEmbedder(opts: EmbedderOptions): Embedder {
  const apiKey = opts.openaiApiKey ?? process.env['OPENAI_API_KEY']
  if (!apiKey) {
    throw new Error('openaiEmbedder: OPENAI_API_KEY is not set')
  }
  const baseUrl = opts.openaiBaseUrl ?? process.env['OPENAI_BASE_URL'] ?? DEFAULT_OPENAI_URL
  const model = opts.openaiModel ?? process.env['OPENAI_EMBED_MODEL'] ?? DEFAULT_OPENAI_MODEL
  let dimension = DEFAULT_OPENAI_DIM
  // Mutable side-channel read by wrapEmbedderWithCostTracker after each
  // call. Set from the API's `usage.total_tokens`; reset to 0 after read.
  const usageBox: { _lastUsageTokens?: number } = {}

  const breaker = makeBreaker(opts, 'openai')
  const maxAttempts = opts.retryMaxAttempts ?? 3

  async function embedMany(texts: string[]): Promise<number[][]> {
    return runWithBreaker(
      breaker,
      () =>
        withRetry(
          async () => {
            const res = await fetch(`${baseUrl}/embeddings`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({ model, input: texts }),
            })
            if (!res.ok) {
              const body = await res.text().catch(() => '')
              throw new Error(`openai embed ${res.status}: ${truncate(redactSecrets(body), 200)}`)
            }
            const data = (await res.json()) as {
              data: Array<{ embedding: number[]; index: number }>
              usage?: { total_tokens?: number; prompt_tokens?: number }
            }
            if (data.usage?.total_tokens != null) {
              usageBox._lastUsageTokens = data.usage.total_tokens
            } else if (data.usage?.prompt_tokens != null) {
              usageBox._lastUsageTokens = data.usage.prompt_tokens
            }
            // Sort by returned index to be defensive against reordering.
            const sorted = [...data.data].sort((a, b) => a.index - b.index)
            if (sorted.length > 0) dimension = sorted[0]!.embedding.length
            return sorted.map((d) => d.embedding)
          },
          { label: 'openai-embed', maxAttempts },
        ),
      { provider: 'openai', model, batch: String(texts.length) },
    )
  }

  const out: Embedder & { _lastUsageTokens?: number } = {
    provider: 'openai',
    model,
    get dimension() {
      return dimension
    },
    embed: async (text: string) => {
      const [v] = await embedMany([text])
      if (!v) throw new Error('openai: empty response')
      return v
    },
    embedBatch: embedMany,
    get _lastUsageTokens() {
      return usageBox._lastUsageTokens
    },
    set _lastUsageTokens(v: number | undefined) {
      usageBox._lastUsageTokens = v
    },
  } as Embedder & { _lastUsageTokens?: number }
  return out
}

// ───────────────────────────────────────────────────────── mock

/**
 * Deterministic, hash-based embedder. Not semantically meaningful, but stable
 * across runs so tests that depend on ordering are reproducible.
 */
export function mockEmbedder(dim = DEFAULT_MOCK_DIM): Embedder {
  const model = `mock-sha256-d${dim}`

  function embedSync(text: string): number[] {
    const out = new Array<number>(dim)
    const normalized = text.trim().toLowerCase()
    // Fill vector by hashing (text, i-chunk) pairs; gives stable pseudo-random distribution.
    let idx = 0
    let chunk = 0
    while (idx < dim) {
      const h = createHash('sha256').update(`${normalized}::${chunk}`).digest()
      for (let b = 0; b < h.length && idx < dim; b += 2) {
        // Map bytes to [-1, 1).
        const u = h.readUInt16BE(b) / 0xffff
        out[idx++] = u * 2 - 1
      }
      chunk++
    }
    // L2-normalize so cosine == dot product.
    let n = 0
    for (let i = 0; i < dim; i++) n += out[i]! * out[i]!
    const inv = n === 0 ? 0 : 1 / Math.sqrt(n)
    for (let i = 0; i < dim; i++) out[i] = out[i]! * inv
    return out
  }

  return {
    provider: 'mock',
    model,
    dimension: dim,
    embed: async (text: string) => embedSync(text),
    embedBatch: async (texts: string[]) => texts.map(embedSync),
  }
}

// ───────────────────────────────────────────────────────── util

function makeBreaker(
  opts: EmbedderOptions,
  name: 'ollama' | 'openai',
): CircuitBreaker | null {
  if (opts.breaker?.enabled === false) return null
  // Only fail-counts on retryable errors that survived the retry budget.
  // Auth errors (401/403) and bad-input (400/422) shouldn't trip the breaker.
  return new CircuitBreaker({
    name: `embedder:${name}`,
    failureThreshold: opts.breaker?.failureThreshold ?? 5,
    cooldownMs: opts.breaker?.cooldownMs ?? 30_000,
    isFailure: opts.breaker?.isFailure ?? defaultEmbedderFailure,
    ...(opts.breaker?.now ? { now: opts.breaker.now } : {}),
  })
}

function defaultEmbedderFailure(err: unknown): boolean {
  // 4xx (except 408/429) is a config issue — don't burn breaker budget on it.
  const status = extractHttpStatus(err)
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false
  }
  return true
}

async function runWithBreaker<T>(
  breaker: CircuitBreaker | null,
  fn: () => Promise<T>,
  attrs: Record<string, string> = {},
): Promise<T> {
  const start = Date.now()
  let outcome: 'ok' | 'error' = 'ok'
  try {
    if (!breaker) return await fn()
    return await breaker.exec(fn)
  } catch (err) {
    outcome = 'error'
    throw err
  } finally {
    recordHistogram(METRIC_NAMES.embedderLatency, Date.now() - start, {
      ...attrs,
      outcome,
    })
  }
}

// Re-export so callers can detect circuit-breaker errors specifically.
export { CircuitBreakerOpenError }


async function boundedMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }
  const n = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}
