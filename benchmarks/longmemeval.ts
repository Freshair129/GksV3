/**
 * LongMemEval benchmark runner.
 *
 * LongMemEval evaluates long-term memory along five axes:
 *   single-session-user, single-session-assistant, single-session-preference,
 *   multi-session, and temporal-reasoning.
 *
 * Dataset shape (as shipped by xiaowu0162/LongMemEval on HuggingFace):
 *
 *   [
 *     {
 *       "question_id": "qid-001",
 *       "question_type": "multi-session" | "temporal-reasoning" | ...,
 *       "question": "…",
 *       "answer": "…",
 *       "answer_session_ids": ["sid-3", "sid-7"],
 *       "haystack_session_ids": ["sid-1","sid-2",...],
 *       "haystack_sessions": { "sid-1": [ {role, content}, ... ], ... },
 *       "haystack_dates": { "sid-1": "2024-05-01", ... }
 *     },
 *     ...
 *   ]
 *
 * What this runner reports (per type + aggregate):
 *   - evidence@1 / evidence@K — gold session appears in top-1 / top-K of Recall
 *   - answer_in_topk          — gold answer text appears in any top-K snippet
 *   - temporal_correct        — for temporal-reasoning questions, whether the
 *                               top hit's ingest date matches any answer session
 *                               date (sanity check only; full reasoning is the
 *                               LLM's job downstream)
 *
 * Usage:
 *   LONGMEMEVAL_DATASET=/path/to/longmemeval_s.json npm run bench:longmemeval
 *   tsx benchmarks/longmemeval.ts --dataset=./data/longmemeval_s.json --top-k=10
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoryStore } from '../src/memory/index.js'
import { recall, retain } from '../src/memory/api.js'
import { createEmbedder } from '../src/memory/vector/embedder.js'
import { createLogger } from '../src/lib/logger.js'
import { fileExists } from '../src/lib/jsonl.js'
import { containsSnippet, normalizeText } from '../src/lib/text.js'
import { isPresent, isRecord, pickArray, toStringArray } from '../src/lib/guards.js'
import {
  createBenchBackend,
  parseBaseBenchArgs,
  prepareWorkDir,
  printReport,
  pct,
  round2,
  type BaseBenchOptions,
  type Provider,
} from './_harness.js'

const log = createLogger('bench:longmemeval')

interface Turn {
  role: 'user' | 'assistant' | string
  content: string
}

interface LongMemEvalItem {
  question_id: string
  question_type: string
  question: string
  answer: string
  answer_session_ids: string[]
  haystack_session_ids: string[]
  haystack_sessions: Record<string, Turn[]>
  haystack_dates?: Record<string, string>
}

interface PerTypeMetrics {
  total: number
  evidence_top1: number
  evidence_topk: number
  answer_in_topk: number
  temporal_correct: number
  temporal_total: number
}

interface RunOptions extends BaseBenchOptions {
  reranker: 'lexical' | 'off'
}

async function main(): Promise<void> {
  const opts = parseOptions()

  if (!(await fileExists(opts.datasetPath))) {
    log.error('dataset not found', { path: opts.datasetPath })
    console.error(
      `\nLongMemEval dataset not found at: ${opts.datasetPath}\n\n` +
        `Set LONGMEMEVAL_DATASET or pass --dataset=<path>.\n` +
        `Download from: https://github.com/xiaowu0162/LongMemEval\n`,
    )
    process.exit(2)
  }

  const items = await loadDataset(opts.datasetPath)
  log.info('dataset loaded', {
    path: opts.datasetPath,
    items: items.length,
    limit: opts.limit ?? 'all',
  })

  await prepareWorkDir(opts.workDir, opts.fresh)

  const embedder = await createEmbedder({
    ...(opts.provider !== 'auto' ? { forceProvider: opts.provider } : {}),
  })

  const benchBackend = await createBenchBackend(opts)
  log.info('backend configured', { backend: benchBackend.description })

  // Reranker selection precedence:
  //   1. --rerank=off      → disabled
  //   2. --rerank-endpoint → HTTP backend (cross-encoder server)
  //   3. otherwise         → lexical BM25 default
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

  const itemsToRun = opts.limit ? items.slice(0, opts.limit) : items

  const byType = new Map<string, PerTypeMetrics>()
  const overall = newMetrics()
  let totalIngestMs = 0
  let totalRecallMs = 0

  for (const item of itemsToRun) {
    const metrics = await runItem(store, item, opts)
    overall.total += 1
    overall.evidence_top1 += metrics.evidence_top1
    overall.evidence_topk += metrics.evidence_topk
    overall.answer_in_topk += metrics.answer_in_topk
    overall.temporal_correct += metrics.temporal_correct
    overall.temporal_total += metrics.temporal_total

    const bucket = byType.get(item.question_type) ?? newMetrics()
    bucket.total += 1
    bucket.evidence_top1 += metrics.evidence_top1
    bucket.evidence_topk += metrics.evidence_topk
    bucket.answer_in_topk += metrics.answer_in_topk
    bucket.temporal_correct += metrics.temporal_correct
    bucket.temporal_total += metrics.temporal_total
    byType.set(item.question_type, bucket)

    totalIngestMs += metrics.ingestMs
    totalRecallMs += metrics.recallMs
  }

  const report = {
    dataset: opts.datasetPath,
    embedder: { provider: embedder.provider, model: embedder.model, dim: embedder.dimension },
    reranker: opts.reranker,
    topK: opts.topK,
    scoreThreshold: opts.scoreThreshold,
    items_run: overall.total,
    overall: metricsReport(overall),
    by_type: Object.fromEntries(
      [...byType.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => [k, metricsReport(v)]),
    ),
    avg_ingest_ms_per_item: round2(totalIngestMs / Math.max(1, overall.total)),
    avg_recall_ms_per_item: round2(totalRecallMs / Math.max(1, overall.total)),
  }

  printReport('LongMemEval Benchmark Report', report)

  await benchBackend.dispose()
}

async function runItem(
  store: MemoryStore,
  item: LongMemEvalItem,
  opts: RunOptions,
): Promise<PerTypeMetrics & { ingestMs: number; recallMs: number }> {
  // Fresh store per item — LongMemEval items are independent.
  const vStore = await store.getVectorStore('atomic')
  await vStore.clear()

  const ingestStart = Date.now()
  for (const sid of item.haystack_session_ids) {
    const turns = item.haystack_sessions[sid] ?? []
    const sessionDate = item.haystack_dates?.[sid]
    for (const turn of turns) {
      if (!turn.content?.trim()) continue
      await retain(store, {
        content: turn.content,
        metadata: {
          path: `${item.question_id}/${sid}`,
          session_id: sid,
          user_id: turn.role,
          tags: ['longmemeval', item.question_type],
          ...(sessionDate ? { valid_from: sessionDate } : {}),
        },
      })
    }
  }
  const ingestMs = Date.now() - ingestStart

  const recallStart = Date.now()
  const res = await recall(store, item.question, {
    strategy: 'vector',
    topK: opts.topK,
    scoreThreshold: opts.scoreThreshold,
  })
  const recallMs = Date.now() - recallStart

  const hits = res.hits
  const goldSessions = new Set(item.answer_session_ids)
  const hitSessions = hits.map(
    (h) => (h.metadata?.['session_id'] as string | undefined) ?? '',
  )
  const top1SessionMatch = hitSessions.length > 0 && goldSessions.has(hitSessions[0]!)
  const topKSessionMatch = hitSessions.some((s) => goldSessions.has(s))

  const answerNorm = normalizeText(item.answer ?? '')
  const answerInTopK = answerNorm
    ? hits.some((h) => containsSnippet(h.snippet, answerNorm))
    : false

  // Temporal-reasoning check: did top-1's session date match any gold date?
  let temporalCorrect = 0
  let temporalTotal = 0
  if (item.question_type.startsWith('temporal')) {
    temporalTotal = 1
    const top1Session = hitSessions[0]
    if (top1Session && item.haystack_dates?.[top1Session]) {
      const top1Date = item.haystack_dates[top1Session]
      const goldDates = item.answer_session_ids
        .map((sid) => item.haystack_dates?.[sid])
        .filter((d): d is string => !!d)
      if (goldDates.some((d) => d === top1Date)) temporalCorrect = 1
    }
  }

  return {
    total: 1,
    evidence_top1: top1SessionMatch ? 1 : 0,
    evidence_topk: topKSessionMatch ? 1 : 0,
    answer_in_topk: answerInTopK ? 1 : 0,
    temporal_correct: temporalCorrect,
    temporal_total: temporalTotal,
    ingestMs,
    recallMs,
  }
}

// ─── io / parsing ──────────────────────────────────────────────────────────

async function loadDataset(path: string): Promise<LongMemEvalItem[]> {
  const raw = await readFile(path, 'utf8')
  const arr = pickArray(JSON.parse(raw), ['items', 'data'])
  return arr.map(normalizeItem).filter(isPresent)
}

function normalizeItem(item: unknown): LongMemEvalItem | null {
  if (!isRecord(item)) return null
  const question_id =
    (item['question_id'] as string | undefined) ?? (item['id'] as string | undefined)
  const question = item['question'] as string | undefined
  const answer = (item['answer'] as string | undefined) ?? ''
  const question_type = (item['question_type'] as string | undefined) ?? 'unknown'
  if (!question_id || !question) return null

  const answer_session_ids = toStringArray(item['answer_session_ids'])
  const haystack_session_ids = toStringArray(
    item['haystack_session_ids'] ?? item['session_ids'],
  )

  const haystack_sessions: Record<string, Turn[]> = {}
  const rawSessions = item['haystack_sessions'] ?? item['sessions']
  if (isRecord(rawSessions)) {
    for (const [sid, turns] of Object.entries(rawSessions)) {
      if (!Array.isArray(turns)) continue
      haystack_sessions[sid] = turns
        .map((t) => (isRecord(t) ? { role: String(t['role'] ?? 'user'), content: String(t['content'] ?? '') } : null))
        .filter(isPresent)
    }
  }

  const haystack_dates: Record<string, string> = {}
  const rawDates = item['haystack_dates'] ?? item['session_dates']
  if (isRecord(rawDates)) {
    for (const [k, v] of Object.entries(rawDates)) {
      if (typeof v === 'string') haystack_dates[k] = v
    }
  }

  return {
    question_id,
    question_type,
    question,
    answer,
    answer_session_ids,
    haystack_session_ids,
    haystack_sessions,
    haystack_dates,
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseOptions(): RunOptions {
  const { base, values } = parseBaseBenchArgs(
    {
      datasetEnvVar: 'LONGMEMEVAL_DATASET',
      datasetDefaultPath: './benchmarks/data/longmemeval_s.json',
      workDirDefault: './benchmarks/.cache/longmemeval-run',
      topKDefault: 10,
      topKEnvVar: 'LONGMEMEVAL_TOPK',
      thresholdDefault: 0.2,
      thresholdEnvVar: 'LONGMEMEVAL_THRESHOLD',
    },
    { reranker: { type: 'string' } },
  )
  const reranker = (values['reranker'] as RunOptions['reranker']) ?? 'lexical'
  return { ...base, reranker }
}

// ─── util ──────────────────────────────────────────────────────────────────

function newMetrics(): PerTypeMetrics {
  return {
    total: 0,
    evidence_top1: 0,
    evidence_topk: 0,
    answer_in_topk: 0,
    temporal_correct: 0,
    temporal_total: 0,
  }
}

function metricsReport(m: PerTypeMetrics): Record<string, number> {
  const out: Record<string, number> = {
    total: m.total,
    evidence_top1_pct: pct(m.evidence_top1, m.total),
    evidence_topk_pct: pct(m.evidence_topk, m.total),
    answer_in_topk_pct: pct(m.answer_in_topk, m.total),
  }
  if (m.temporal_total > 0) {
    out['temporal_top1_pct'] = pct(m.temporal_correct, m.temporal_total)
  }
  return out
}


main().catch((err) => {
  log.error('benchmark failed', { err: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
