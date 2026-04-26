#!/usr/bin/env tsx
/**
 * BEAM benchmark runner — scale + latency + token-savings.
 *
 * Spec reference (user Spec §5.3): "BEAM (10M Tokens) — ทดสอบการดึงข้อมูลใน
 * ระดับความจุสูงสุด. Metric: วัด Token Savings (ต้องลดการใช้ Token ได้ > 90%)
 * และ Latency (< 200ms p95)".
 *
 * What this runner measures
 *   - ingest_total_ms + avg_ingest_ms_per_chunk — how long to build the store
 *   - recall_latency: p50 / p90 / p95 / p99 across N queries (ms)
 *   - token_savings_pct: 1 - (tokens_retrieved / tokens_total)
 *                        where tokens_retrieved is the sum of tokens in the
 *                        topK snippets returned for the query set, and
 *                        tokens_total is the full corpus token count. The
 *                        claim "90% token savings" means: at recall time we
 *                        only need to surface ≤ 10% of the corpus tokens.
 *   - docs_indexed + embedder info + reranker info
 *
 * Dataset shapes (best-effort auto-detect):
 *   - JSONL: one document per line, { id?, text, metadata? }
 *   - JSON:  { documents: [...] } or bare [] of the same shape
 *   - TXT:   split by double-newline paragraphs, each becomes a doc
 *
 * Query set shapes:
 *   - JSONL of { query, ... } (extra fields ignored)
 *   - JSON of [ {query}, ... ]
 *   - If no query set supplied, we synthesize 200 queries by sampling the
 *     first sentence of randomly selected documents — rough but reproducible
 *     under --seed.
 *
 * Usage:
 *   tsx benchmarks/beam.ts --corpus=./data/beam-corpus.jsonl
 *   tsx benchmarks/beam.ts --corpus=./beam.jsonl --queries=./queries.json
 *   tsx benchmarks/beam.ts --corpus=./beam.jsonl --top-k=10 --provider=ollama
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { MemoryStore } from '../src/memory/index.js'
import { recall, retain } from '../src/memory/api.js'
import { createEmbedder } from '../src/memory/vector/embedder.js'
import { estimateTokens } from '../src/memory/vector/chunker.js'
import { fileExists, forEachJsonl } from '../src/lib/jsonl.js'
import { isRecord, pickArray } from '../src/lib/guards.js'
import { createLogger } from '../src/lib/logger.js'
import {
  createBenchBackend,
  parseBaseBenchArgs,
  percentile,
  prepareWorkDir,
  printReport,
  round2,
  type BaseBenchOptions,
} from './_harness.js'

const log = createLogger('bench:beam')

interface CorpusDoc {
  id?: string
  text: string
  metadata?: Record<string, unknown>
}

interface RunOptions extends BaseBenchOptions {
  queriesPath?: string
  queryLimit: number
  reranker: 'lexical' | 'off'
  seed: number
}

async function main(): Promise<void> {
  const opts = parseOptions()

  if (!(await fileExists(opts.datasetPath))) {
    log.error('corpus not found', { path: opts.datasetPath })
    console.error(`\nBEAM corpus not found at: ${opts.datasetPath}\n`)
    process.exit(2)
  }

  const corpus = await loadCorpus(opts.datasetPath)
  log.info('corpus loaded', { path: opts.datasetPath, docs: corpus.length })

  const docsToIngest = opts.limit ? corpus.slice(0, opts.limit) : corpus
  const totalTokens = docsToIngest.reduce((a, d) => a + estimateTokens(d.text), 0)

  const queries = opts.queriesPath
    ? await loadQueries(opts.queriesPath)
    : synthesizeQueries(docsToIngest, opts.queryLimit, opts.seed)
  log.info('queries loaded', {
    source: opts.queriesPath ?? 'synthesized',
    count: queries.length,
  })

  await prepareWorkDir(opts.workDir, opts.fresh)

  const embedder = await createEmbedder({
    ...(opts.provider !== 'auto' ? { forceProvider: opts.provider } : {}),
  })

  const benchBackend = await createBenchBackend(opts)
  log.info('backend configured', { backend: benchBackend.description })

  const rerankerOpt =
    opts.reranker === 'off'
      ? { enabled: false }
      : opts.rerank
        ? opts.rerank
        : { backend: 'lexical' as const }

  const store = new MemoryStore({
    root: opts.workDir,
    embedder,
    atomicIndexPath: join(opts.workDir, 'gks', '00_index', 'atomic_index.jsonl'),
    vectorScoreThreshold: opts.scoreThreshold,
    reranker: rerankerOpt,
    ...(benchBackend.factory ? { vectorBackend: benchBackend.factory } : {}),
  })
  await store.init()

  // ── Ingestion ────────────────────────────────────────────────────────────
  const ingestStart = Date.now()
  let chunksIngested = 0
  for (const doc of docsToIngest) {
    await retain(store, {
      content: doc.text,
      metadata: {
        path: doc.id ?? 'inline',
        ...(doc.metadata ?? {}),
      } as Record<string, unknown>,
    })
    chunksIngested += 1
  }
  const ingestMs = Date.now() - ingestStart

  // ── Recall sweep ─────────────────────────────────────────────────────────
  const latencies: number[] = []
  let totalRetrievedTokens = 0
  let totalHits = 0

  for (const q of queries) {
    const t0 = Date.now()
    const res = await recall(store, q, {
      strategy: 'vector',
      topK: opts.topK,
      scoreThreshold: opts.scoreThreshold,
    })
    const dt = Date.now() - t0
    latencies.push(dt)
    totalHits += res.hits.length
    for (const h of res.hits) totalRetrievedTokens += estimateTokens(h.snippet)
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const totalRetrievedEstimate = totalRetrievedTokens / Math.max(1, queries.length)
  // "Savings per query" — at recall time we surface this many tokens vs. the
  // total corpus. 90% savings means we return <= 10% of corpus tokens per query.
  const savingsPct =
    totalTokens > 0
      ? Math.max(0, 1 - totalRetrievedEstimate / totalTokens) * 100
      : 0

  const report = {
    corpus: opts.datasetPath,
    queries: { source: opts.queriesPath ?? 'synthesized', count: queries.length },
    embedder: { provider: embedder.provider, model: embedder.model, dim: embedder.dimension },
    reranker: opts.reranker,
    topK: opts.topK,
    scale: {
      docs_indexed: chunksIngested,
      total_corpus_tokens: totalTokens,
      avg_tokens_per_doc: round2(totalTokens / Math.max(1, chunksIngested)),
    },
    ingest: {
      total_ms: ingestMs,
      avg_ms_per_doc: round2(ingestMs / Math.max(1, chunksIngested)),
    },
    recall: {
      queries_run: queries.length,
      avg_hits_per_query: round2(totalHits / Math.max(1, queries.length)),
      p50_ms: percentile(latencies, 50),
      p90_ms: percentile(latencies, 90),
      p95_ms: percentile(latencies, 95),
      p99_ms: percentile(latencies, 99),
    },
    token_savings: {
      avg_retrieved_tokens_per_query: round2(totalRetrievedEstimate),
      savings_pct: round2(savingsPct),
      target_90pct_met: savingsPct >= 90,
      target_p95_200ms_met: percentile(latencies, 95) < 200,
    },
  }

  printReport('BEAM Benchmark Report', report)

  await benchBackend.dispose()

  // Non-zero exit if a target was explicitly missed (useful for CI gating).
  if (process.env['BEAM_STRICT'] === '1') {
    if (!report.token_savings.target_90pct_met || !report.token_savings.target_p95_200ms_met) {
      process.exit(3)
    }
  }
}

// ─── io ─────────────────────────────────────────────────────────────────

async function loadCorpus(path: string): Promise<CorpusDoc[]> {
  if (path.endsWith('.jsonl')) {
    const out: CorpusDoc[] = []
    await forEachJsonl<unknown>(path, (row) => {
      const doc = normalizeDoc(row)
      if (doc.text.length > 0) out.push(doc)
    })
    return out
  }
  if (path.endsWith('.json')) {
    const arr = pickArray(JSON.parse(await readFile(path, 'utf8')), ['documents', 'data'])
    return arr.map(normalizeDoc).filter((d): d is CorpusDoc => d.text.length > 0)
  }
  // Plain text: split by double-newline paragraphs.
  const txt = await readFile(path, 'utf8')
  return txt
    .split(/\n{2,}/)
    .map((t, i) => ({ id: `p-${i}`, text: t.trim() }))
    .filter((d) => d.text.length > 0)
}

function normalizeDoc(x: unknown): CorpusDoc {
  if (typeof x === 'string') return { text: x }
  if (!isRecord(x)) return { text: '' }
  const text =
    (x['text'] as string | undefined) ??
    (x['content'] as string | undefined) ??
    (x['body'] as string | undefined) ??
    ''
  return {
    ...(typeof x['id'] === 'string' ? { id: x['id'] } : {}),
    text,
    ...(isRecord(x['metadata']) ? { metadata: x['metadata'] as Record<string, unknown> } : {}),
  }
}

async function loadQueries(path: string): Promise<string[]> {
  if (path.endsWith('.jsonl')) {
    const out: string[] = []
    await forEachJsonl<unknown>(path, (row) => {
      const q = extractQuery(row)
      if (q) out.push(q)
    })
    return out
  }
  const arr = pickArray(JSON.parse(await readFile(path, 'utf8')), ['queries'])
  return arr.map(extractQuery).filter((q): q is string => !!q)
}

function extractQuery(x: unknown): string {
  if (typeof x === 'string') return x
  if (!isRecord(x)) return ''
  return (
    (x['query'] as string | undefined) ??
    (x['q'] as string | undefined) ??
    (x['text'] as string | undefined) ??
    ''
  )
}

function synthesizeQueries(corpus: CorpusDoc[], n: number, seed: number): string[] {
  if (corpus.length === 0) return []
  const rng = mulberry32(seed)
  const out: string[] = []
  const wanted = Math.min(n, corpus.length)
  const used = new Set<number>()
  while (out.length < wanted) {
    const idx = Math.floor(rng() * corpus.length)
    if (used.has(idx)) continue
    used.add(idx)
    const sentence = firstSentence(corpus[idx]!.text)
    if (sentence.length > 10) out.push(sentence)
  }
  return out
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim())
  return (m ? m[1]! : text).slice(0, 180).trim()
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseOptions(): RunOptions {
  const { base, values } = parseBaseBenchArgs(
    {
      // BEAM aliases 'dataset' to the more domain-appropriate 'corpus' in docs,
      // but accepts either via BEAM_CORPUS env and (below) a --corpus flag.
      datasetEnvVar: 'BEAM_CORPUS',
      datasetDefaultPath: './benchmarks/data/beam-tiny.jsonl',
      workDirDefault: './benchmarks/.cache/beam-run',
      topKDefault: 5,
      topKEnvVar: 'BEAM_TOPK',
      thresholdDefault: 0.2,
    },
    {
      corpus: { type: 'string' },
      queries: { type: 'string' },
      'query-limit': { type: 'string' },
      reranker: { type: 'string' },
      seed: { type: 'string' },
    },
  )

  // Allow --corpus as an alias for --dataset (BEAM's historical name).
  const corpusOverride = values['corpus'] as string | undefined
  const datasetPath = corpusOverride ? resolve(corpusOverride) : base.datasetPath

  const queriesPathVal =
    (values['queries'] as string | undefined) ?? process.env['BEAM_QUERIES']

  return {
    ...base,
    datasetPath,
    ...(queriesPathVal ? { queriesPath: resolve(queriesPathVal) } : {}),
    queryLimit: Number(values['query-limit'] ?? 200),
    reranker: (values['reranker'] as RunOptions['reranker']) ?? 'lexical',
    seed: Number(values['seed'] ?? 42),
  }
}

main().catch((err) => {
  log.error('benchmark failed', { err: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
