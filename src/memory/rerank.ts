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
  backend?: 'lexical' | 'http' | 'transformers' | 'custom'
  /** HTTP endpoint that accepts { query, documents } and returns { scores: [] }. */
  endpoint?: string
  /** HTTP bearer token. */
  apiKey?: string
  /** Custom scorer (wins over backend/endpoint). */
  score?: Reranker['score']
  /**
   * Cross-encoder model id for backend='transformers'. Defaults to
   * Xenova/bge-reranker-v2-m3 (568MB, multilingual incl. Thai). Other
   * supported options:
   *   - Xenova/bge-reranker-base    (~280MB, English-leaning)
   *   - Xenova/jina-reranker-v2-base-multilingual  (~280MB, multilingual)
   */
  model?: string
  /**
   * Override for the transformers.js cross-encoder loader. Used by tests
   * to inject a mock without pulling 600MB on first call. Production
   * callers should leave this undefined and let the default loader
   * dynamically import @huggingface/transformers.
   */
  crossEncoderLoader?: CrossEncoderLoader
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
  if (backend === 'transformers') {
    return transformersReranker({
      model: opts.model ?? 'Xenova/bge-reranker-v2-m3',
      ...(opts.crossEncoderLoader ? { loader: opts.crossEncoderLoader } : {}),
    })
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

// ─── transformers (local cross-encoder via @huggingface/transformers) ─────

/**
 * Score function returned by a CrossEncoderLoader. Takes (query, docs) and
 * returns one relevance logit per doc — higher = more relevant. The blend
 * stage applies min-max normalization (when enabled) before mixing with the
 * first-pass score, so absolute magnitude doesn't matter, just ordering.
 */
export type CrossEncoderScorer = (
  query: string,
  texts: readonly string[],
) => Promise<number[]>

/**
 * Lazy loader for a cross-encoder model. The default implementation imports
 * @huggingface/transformers on first call and pulls the model from the HF
 * hub (~600MB for bge-reranker-v2-m3). Tests inject a stub.
 */
export type CrossEncoderLoader = (model: string) => Promise<CrossEncoderScorer>

interface TransformersRerankerOptions {
  model: string
  loader?: CrossEncoderLoader
}

function transformersReranker(opts: TransformersRerankerOptions): Reranker {
  const loader = opts.loader ?? defaultCrossEncoderLoader
  let scorer: CrossEncoderScorer | null = null
  let pending: Promise<CrossEncoderScorer> | null = null

  async function getScorer(): Promise<CrossEncoderScorer> {
    if (scorer) return scorer
    if (pending) return pending
    pending = (async () => {
      log.info('transformers reranker: loading model (first call may download ~600MB)', {
        model: opts.model,
      })
      const fn = await loader(opts.model)
      scorer = fn
      log.info('transformers reranker: model ready', { model: opts.model })
      return fn
    })()
    try {
      return await pending
    } finally {
      pending = null
    }
  }

  return {
    name: `transformers:${opts.model}`,
    async score(query, texts) {
      if (texts.length === 0) return []
      const start = Date.now()
      let outcome: 'ok' | 'error' = 'ok'
      try {
        const fn = await getScorer()
        const out = await fn(query, texts)
        if (out.length !== texts.length) {
          throw new Error(
            `transformers reranker: expected ${texts.length} scores, got ${out.length}`,
          )
        }
        return out
      } catch (err) {
        outcome = 'error'
        throw err
      } finally {
        recordHistogram(METRIC_NAMES.rerankLatency, Date.now() - start, {
          backend: 'transformers',
          model: opts.model,
          batch: String(texts.length),
          outcome,
        })
      }
    },
  }
}

/**
 * Default cross-encoder loader. Imports @huggingface/transformers lazily
 * (only when this reranker actually runs — keeps the module import cost
 * zero for callers using the lexical or http backends).
 *
 * Uses AutoTokenizer + AutoModelForSequenceClassification to call BGE-style
 * cross-encoders directly: tokenize (query, doc) pairs, run a forward pass,
 * read the single relevance logit from the output tensor. Pinned to fp32
 * for determinism — quantized variants drift on edge cases.
 */
async function defaultCrossEncoderLoader(model: string): Promise<CrossEncoderScorer> {
  // Dynamic import keeps the @huggingface/transformers cost off the critical
  // path for users who never enable this backend.
  const transformers = (await import('@huggingface/transformers')) as unknown as {
    AutoTokenizer: { from_pretrained(model: string): Promise<TokenizerLike> }
    AutoModelForSequenceClassification: {
      from_pretrained(model: string, opts?: { dtype?: string }): Promise<CrossEncoderModelLike>
    }
    env?: { allowLocalModels?: boolean }
  }
  if (transformers.env) transformers.env.allowLocalModels = true

  const tokenizer = await transformers.AutoTokenizer.from_pretrained(model)
  const xmodel = await transformers.AutoModelForSequenceClassification.from_pretrained(model, {
    dtype: 'fp32',
  })

  return async (query, texts) => {
    const queries = texts.map(() => query)
    const inputs = await tokenizer(queries, {
      text_pair: [...texts],
      padding: true,
      truncation: true,
    })
    const output = await xmodel(inputs)
    const logits = output.logits
    const data = logits.data as Float32Array | number[]
    const dims = (logits.dims ?? logits.shape ?? [texts.length]) as number[]
    // BGE-style rerankers emit a single regression logit per pair; reshape
    // defensively in case a model produces multi-class output (take col 0).
    const cols = dims.length > 1 ? dims[1]! : 1
    const out = new Array<number>(texts.length)
    for (let i = 0; i < texts.length; i++) out[i] = Number(data[i * cols] ?? 0)
    return out
  }
}

interface TokenizerLike {
  (
    texts: string[],
    opts: { text_pair?: string[]; padding?: boolean; truncation?: boolean },
  ): Promise<unknown>
}

interface CrossEncoderModelLike {
  (inputs: unknown): Promise<{
    logits: { data: Float32Array | number[]; dims?: number[]; shape?: number[] }
  }>
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
