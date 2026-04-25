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
import { withRetry } from '../../lib/retry.js'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitBreakerOptions,
} from '../../lib/circuit-breaker.js'
import { METRIC_NAMES, recordHistogram } from '../../lib/telemetry.js'

const log = createLogger('vector:embedder')

export interface EmbedderInfo {
  provider: 'ollama' | 'openai' | 'mock'
  model: string
  dimension: number
}

export interface Embedder extends EmbedderInfo {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

export interface EmbedderOptions {
  provider?: 'ollama' | 'openai' | 'mock' | 'auto'
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

  // Auto mode: try Ollama, fall back to OpenAI, fall back to mock.
  const ollamaUrl = opts.ollamaBaseUrl ?? process.env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_URL
  if (await isOllamaAvailable(ollamaUrl)) {
    log.info('embedder: ollama selected', { url: ollamaUrl })
    return ollamaEmbedder(opts)
  }

  const apiKey = opts.openaiApiKey ?? process.env['OPENAI_API_KEY']
  if (apiKey) {
    log.info('embedder: openai selected (ollama unavailable)')
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
              throw new Error(`ollama embed ${res.status}: ${body.slice(0, 200)}`)
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
              throw new Error(`openai embed ${res.status}: ${body.slice(0, 200)}`)
            }
            const data = (await res.json()) as {
              data: Array<{ embedding: number[]; index: number }>
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

  return {
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
  } as Embedder
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
  const msg = String((err as Error).message ?? err)
  // 4xx (except 408/429) shouldn't trip the breaker — fixing those needs a
  // config change, not a wait.
  const m = /\b(\d{3})\b/.exec(msg)
  if (m) {
    const status = Number(m[1])
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false
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
