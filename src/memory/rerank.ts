/**
 * Reranker — second-pass scoring over top-K retrieval hits.
 *
 * Why rerank?  First-pass retrieval is recall-heavy (catch-all) but precision-
 * light. A cross-encoder (or a cheap lexical heuristic) reads query + candidate
 * together and produces a calibrated score — typically worth +5-15 points of
 * evidence@5 on LoCoMo at the cost of one extra HTTP call per query.
 *
 * Backends:
 *   - 'lexical'   (default): TF-IDF-ish BM25 lite — zero network, zero deps.
 *                 Surprisingly competitive on short snippets; used as the
 *                 always-available fallback.
 *   - 'http'      : POST { query, documents } to a user-provided endpoint,
 *                   expect { scores: number[] } back. Compatible with BGE
 *                   rerank servers (text-embeddings-inference, jina-reranker-v2,
 *                   etc.).
 *   - custom      : pass your own `score(query, texts) => number[]` function.
 *
 * Integration: MemoryStore.retrieve() invokes the reranker after merge/dedup
 * and before the maxTotal cap. See src/memory/index.ts.
 */

import { redactSecrets, tokenize, truncate } from '../lib/text.js'
import { withRetry } from '../lib/retry.js'
import { METRIC_NAMES, recordHistogram } from '../lib/telemetry.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('memory:rerank')

export interface Reranker {
  readonly name: string
  /** Score each document in-context against the query. Higher = more relevant. */
  score(query: string, texts: readonly string[]): Promise<number[]>
}

export interface RerankerOptions {
  backend?: 'lexical' | 'http' | 'custom'
  /** HTTP endpoint that accepts { query, documents } and returns { scores: [] }. */
  endpoint?: string
  /** HTTP bearer token. */
  apiKey?: string
  /** Custom scorer (wins over backend/endpoint). */
  score?: Reranker['score']
  /** Blend weight — final = (1 - alpha) * firstPass + alpha * rerankerScore. */
  alpha?: number
  /** Normalize reranker scores into [0, 1] via min-max before blending. */
  normalize?: boolean
  /** Only rerank the top-N first-pass hits. Default 20. */
  limit?: number
}

export interface RerankInput<T> {
  query: string
  hits: T[]
  /** Tell the reranker how to extract text from each hit. */
  getText: (hit: T) => string
  /** Tell the reranker how to read the first-pass score from each hit. */
  getScore: (hit: T) => number
  /** Set the blended score on a returned (shallow) copy of each hit. */
  withScore: (hit: T, score: number) => T
}

export async function rerank<T>(
  reranker: Reranker,
  input: RerankInput<T>,
  opts: { alpha: number; normalize: boolean; limit: number },
): Promise<T[]> {
  if (input.hits.length === 0) return input.hits

  const limited = input.hits.slice(0, opts.limit)
  const texts = limited.map(input.getText)

  let scores: number[]
  try {
    scores = await reranker.score(input.query, texts)
  } catch (err) {
    log.warn('reranker failed — returning first-pass order', {
      reranker: reranker.name,
      error: (err as Error).message,
    })
    return input.hits
  }

  if (scores.length !== limited.length) {
    log.warn('reranker returned wrong number of scores — keeping first-pass order', {
      expected: limited.length,
      got: scores.length,
    })
    return input.hits
  }

  const normalized = opts.normalize ? minMax(scores) : scores
  const rescored = limited
    .map((hit, i) => {
      const first = input.getScore(hit)
      const second = normalized[i]!
      const blended = (1 - opts.alpha) * first + opts.alpha * second
      return input.withScore(hit, blended)
    })
    .sort((a, b) => input.getScore(b) - input.getScore(a))

  // Preserve anything past `limit` at the tail (unchanged).
  return rescored.concat(input.hits.slice(opts.limit))
}

export function createReranker(opts: RerankerOptions = {}): Reranker {
  if (opts.score) return { name: 'custom', score: opts.score }
  const backend = opts.backend ?? (opts.endpoint ? 'http' : 'lexical')
  if (backend === 'http') {
    if (!opts.endpoint) throw new Error('createReranker: backend=http requires endpoint')
    return httpReranker(opts.endpoint, opts.apiKey)
  }
  return lexicalReranker()
}

// ─── lexical (BM25-lite) ───────────────────────────────────────────────────

/**
 * A tiny BM25-ish scorer. Good enough as a default reranker and has the
 * pleasant property that on degenerate inputs (empty query, empty docs) it
 * degrades to returning zeros instead of crashing.
 *
 * Constants are the usual BM25 defaults (k1=1.5, b=0.75). Term frequency is
 * capped implicitly by the saturation term. IDF uses the standard
 * log((N - df + 0.5) / (df + 0.5) + 1).
 */
function lexicalReranker(): Reranker {
  return {
    name: 'lexical-bm25',
    async score(query, texts) {
      const qTerms = tokenize(query)
      if (qTerms.length === 0) return texts.map(() => 0)
      const docs = texts.map(tokenize)
      const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length)
      const N = docs.length

      const df = new Map<string, number>()
      for (const d of docs) {
        const seen = new Set(d)
        for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
      }

      const k1 = 1.5
      const b = 0.75
      return docs.map((d) => {
        const len = d.length
        const tf = new Map<string, number>()
        for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1)
        let s = 0
        for (const q of qTerms) {
          const f = tf.get(q) ?? 0
          if (f === 0) continue
          const n = df.get(q) ?? 0
          const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1)
          const num = f * (k1 + 1)
          const denom = f + k1 * (1 - b + b * (len / Math.max(1, avgLen)))
          s += idf * (num / denom)
        }
        return s
      })
    },
  }
}

// ─── http (BGE rerank-compatible) ──────────────────────────────────────────

function httpReranker(endpoint: string, apiKey?: string): Reranker {
  const host = new URL(endpoint).host
  return {
    name: `http:${host}`,
    async score(query, texts) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`

      const start = Date.now()
      let outcome: 'ok' | 'error' = 'ok'
      try {
        return await withRetry(
          async () => {
            const res = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify({ query, documents: [...texts] }),
            })
            if (!res.ok) {
              const body = await res.text().catch(() => '')
              throw new Error(`rerank http ${res.status}: ${truncate(redactSecrets(body), 200)}`)
            }
            const data = (await res.json()) as {
              scores?: number[]
              results?: Array<{ score: number }>
            }
            if (Array.isArray(data.scores)) return data.scores
            if (Array.isArray(data.results)) return data.results.map((r) => r.score)
            throw new Error("rerank http: response missing 'scores' or 'results'")
          },
          { label: 'rerank-http' },
        )
      } catch (err) {
        outcome = 'error'
        throw err
      } finally {
        recordHistogram(METRIC_NAMES.rerankLatency, Date.now() - start, {
          backend: 'http',
          host,
          batch: String(texts.length),
          outcome,
        })
      }
    },
  }
}

// ─── util ──────────────────────────────────────────────────────────────────

function minMax(values: readonly number[]): number[] {
  if (values.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  if (span === 0) return values.map(() => 0.5)
  return values.map((v) => (v - min) / span)
}
