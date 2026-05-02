/**
 * Local embedder using nomic-embed-text-v1.5 via @huggingface/transformers.
 *
 * Design decisions (ADR--NOMIC-EMBEDDER):
 *   - fp32 precision by default; opt-in q8 quantization for CPU-only
 *     environments via createNomicEmbedder({ dtype: 'q8' })
 *   - Fixed model: nomic-ai/nomic-embed-text-v1.5 (768-dim, Thai+English)
 *   - Task prefixes applied internally — callers pass raw text only
 *   - Pipeline loaded once per (model, dtype) combo, lazy on first call
 *   - Progress logged to stderr on first download
 *
 * Quantization trade-off (q8):
 *   - Disk + RAM:    ~140MB vs ~550MB fp32 (4× smaller)
 *   - Throughput:    2-3× faster on CPU-only environments
 *   - Quality:       <2% drop on MTEB benchmarks; not detectable in
 *                    typical recall workflows. fp32 stays the default
 *                    for archival / benchmark settings.
 */

import { createLogger } from '../../lib/logger.js'
import type { Embedder } from './embedder.js'

const log = createLogger('vector:embedder:nomic')

const MODEL = 'nomic-ai/nomic-embed-text-v1.5'
const DIMENSION = 768
const DOC_PREFIX = 'search_document: '
const QUERY_PREFIX = 'search_query: '

export type NomicDtype = 'fp32' | 'fp16' | 'q8' | 'q4'

export interface NomicEmbedderOptions {
  /**
   * Model precision. fp32 (default) keeps full-quality embeddings at
   * ~550MB; q8 trades <2% MTEB quality for 4× smaller footprint
   * (~140MB) and 2-3× CPU speedup. q4 is even smaller but quality drop
   * starts to show.
   *
   * Override via the `GKS_NOMIC_DTYPE` env var if not passed.
   */
  dtype?: NomicDtype
}

type Pipeline = {
  (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }[]>
}

const _pipelines = new Map<NomicDtype, Pipeline>()
const _pipelinesPending = new Map<NomicDtype, Promise<Pipeline>>()

async function getPipeline(dtype: NomicDtype): Promise<Pipeline> {
  const cached = _pipelines.get(dtype)
  if (cached) return cached
  const pending = _pipelinesPending.get(dtype)
  if (pending) return pending

  const loading = (async () => {
    const sizeNote =
      dtype === 'fp32' ? '~550MB' : dtype === 'fp16' ? '~280MB' : dtype === 'q8' ? '~140MB' : '~80MB'
    log.info(`nomic: loading model (first call — may download ${sizeNote})`, { model: MODEL, dtype })

    const { pipeline, env } = await import('@huggingface/transformers')

    env.allowLocalModels = true

    let lastPct = -1
    const originalConsoleLog = console.error

    // @huggingface/transformers logs download progress to stderr
    // intercept to reformat as structured log lines
    console.error = (...args: unknown[]) => {
      const msg = args.join(' ')
      const match = msg.match(/(\d+(\.\d+)?)%/)
      if (match) {
        const pct = Math.floor(Number(match[1]) / 10) * 10
        if (pct !== lastPct) {
          lastPct = pct
          process.stderr.write(`[gks:nomic] downloading ${MODEL} (${dtype}): ${pct}%\n`)
        }
      } else {
        originalConsoleLog(...args)
      }
    }

    try {
      const pipe = (await pipeline('feature-extraction', MODEL, {
        dtype,
      })) as unknown as Pipeline
      _pipelines.set(dtype, pipe)
      log.info('nomic: model ready', { model: MODEL, dim: DIMENSION, dtype })
      return pipe
    } finally {
      console.error = originalConsoleLog
    }
  })()
  _pipelinesPending.set(dtype, loading)
  try {
    return await loading
  } finally {
    _pipelinesPending.delete(dtype)
  }
}

export function createNomicEmbedder(opts: NomicEmbedderOptions = {}): Embedder {
  const dtype = (opts.dtype ?? (process.env['GKS_NOMIC_DTYPE'] as NomicDtype | undefined) ?? 'fp32') as NomicDtype

  async function embedOne(text: string, isQuery = false): Promise<number[]> {
    const pipe = await getPipeline(dtype)
    const prefixed = (isQuery ? QUERY_PREFIX : DOC_PREFIX) + text
    const output = await pipe([prefixed], { pooling: 'mean', normalize: true })
    return Array.from(output[0]!.data)
  }

  async function embedBatch(texts: string[], isQuery = false): Promise<number[][]> {
    const pipe = await getPipeline(dtype)
    const prefixed = texts.map((t) => (isQuery ? QUERY_PREFIX : DOC_PREFIX) + t)
    const output = await pipe(prefixed, { pooling: 'mean', normalize: true })
    return output.map((o) => Array.from(o.data))
  }

  // Stamp the dtype into the model id so manifests can distinguish
  // q8-indexed stores from fp32-indexed ones (re-embed required if you
  // switch dtype after building an index).
  const modelId = dtype === 'fp32' ? MODEL : `${MODEL}@${dtype}`

  return {
    provider: 'nomic',
    model: modelId,
    dimension: DIMENSION,
    embed: (text: string) => embedOne(text, false),
    embedBatch: (texts: string[]) => embedBatch(texts, false),
    embedQuery: (text: string) => embedOne(text, true),
    embedQueryBatch: (texts: string[]) => embedBatch(texts, true),
  } as Embedder & {
    embedQuery(text: string): Promise<number[]>
    embedQueryBatch(texts: string[]): Promise<number[][]>
  }
}
