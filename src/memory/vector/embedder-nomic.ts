/**
 * Local embedder using nomic-embed-text-v1.5 via @huggingface/transformers.
 *
 * Design decisions (ADR--NOMIC-EMBEDDER):
 *   - fp32 precision, no quantization
 *   - Fixed model: nomic-ai/nomic-embed-text-v1.5 (768-dim, Thai+English)
 *   - Task prefixes applied internally — callers pass raw text only
 *   - Pipeline loaded once (singleton), lazy on first call
 *   - Progress logged to stderr on first download (~550MB)
 */

import { createLogger } from '../../lib/logger.js'
import type { Embedder } from './embedder.js'

const log = createLogger('vector:embedder:nomic')

const MODEL = 'nomic-ai/nomic-embed-text-v1.5'
const DIMENSION = 768
const DOC_PREFIX = 'search_document: '
const QUERY_PREFIX = 'search_query: '

type Pipeline = {
  (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }[]>
}

let _pipeline: Pipeline | null = null
let _loading: Promise<Pipeline> | null = null

async function getPipeline(): Promise<Pipeline> {
  if (_pipeline) return _pipeline
  if (_loading) return _loading

  _loading = (async () => {
    log.info('nomic: loading model (first call — may download ~550MB)', { model: MODEL })

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
          process.stderr.write(`[gks:nomic] downloading ${MODEL}: ${pct}%\n`)
        }
      } else {
        originalConsoleLog(...args)
      }
    }

    try {
      const pipe = await pipeline('feature-extraction', MODEL, {
        dtype: 'fp32',
      }) as unknown as Pipeline
      _pipeline = pipe
      log.info('nomic: model ready', { model: MODEL, dim: DIMENSION })
      return pipe
    } finally {
      console.error = originalConsoleLog
    }
  })()

  return _loading
}

export function createNomicEmbedder(): Embedder {
  async function embedOne(text: string, isQuery = false): Promise<number[]> {
    const pipe = await getPipeline()
    const prefixed = (isQuery ? QUERY_PREFIX : DOC_PREFIX) + text
    const output = await pipe([prefixed], { pooling: 'mean', normalize: true })
    return Array.from(output[0]!.data)
  }

  async function embedBatch(texts: string[], isQuery = false): Promise<number[][]> {
    const pipe = await getPipeline()
    const prefixed = texts.map((t) => (isQuery ? QUERY_PREFIX : DOC_PREFIX) + t)
    const output = await pipe(prefixed, { pooling: 'mean', normalize: true })
    return output.map((o) => Array.from(o.data))
  }

  return {
    provider: 'nomic',
    model: MODEL,
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
