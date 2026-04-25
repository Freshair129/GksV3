/**
 * LoCoMo benchmark runner — Phase 1 skeleton.
 *
 * LoCoMo (Long-context Memory) evaluates an agent's ability to recall facts
 * from very long multi-session conversations. Each conversation bundle ships
 * ~10 dialog sessions and a QA set. We ingest the dialogs into the GKS memory
 * fabric, then answer the QA set using Recall() and score accuracy.
 *
 * This runner is deliberately lightweight — no LLM in the loop. Its job is to
 * exercise the Retain/Recall path end-to-end on real-shape data so we can:
 *
 *   (a) verify that retrieval hits contain the ground-truth evidence text, and
 *   (b) track top-1 / top-k "evidence recall" as a ceiling metric for the full
 *       pipeline (adding an LLM on top can only match or drop this number).
 *
 * Usage:
 *   LOCOMO_DATASET=/path/to/locomo10.json npm run bench:locomo
 *   LOCOMO_DATASET=/path/to/locomo10.json tsx benchmarks/locomo.ts --top-k 10
 *
 * Dataset format (best-effort auto-detect — supports a few shapes seen in the
 * wild, including the snapshotimage/locomo10 HuggingFace mirror):
 *
 *   {
 *     "conversations": [
 *       {
 *         "id": "conv-001",
 *         "sessions": [
 *           { "session_id": "s1", "messages": [ { "speaker": "A", "text": "..." }, ... ] },
 *           ...
 *         ],
 *         "qa": [
 *           { "question": "...", "answer": "...", "evidence": ["..."] },
 *           ...
 *         ]
 *       }
 *     ]
 *   }
 *
 * or equivalently, a flat `{sample: [...]}` / `samples: [...]` wrapper.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MemoryStore } from '../src/memory/index.js'
import { recall, retain } from '../src/memory/api.js'
import { createEmbedder } from '../src/memory/vector/embedder.js'
import { createLogger } from '../src/lib/logger.js'
import { fileExists } from '../src/lib/jsonl.js'
import { containsSnippet, normalizeText } from '../src/lib/text.js'
import { isPresent, isRecord, pickArray } from '../src/lib/guards.js'
import {
  createBenchBackend,
  parseBaseBenchArgs,
  prepareWorkDir,
  printReport,
  pct,
  round2,
  type BaseBenchOptions,
} from './_harness.js'

const log = createLogger('bench:locomo')

interface LocomoMessage {
  speaker: string
  text: string
  timestamp?: string
}

interface LocomoSession {
  session_id: string
  messages: LocomoMessage[]
}

interface LocomoQa {
  question: string
  answer: string
  evidence?: string[]
  category?: string
}

interface LocomoConversation {
  id: string
  sessions: LocomoSession[]
  qa: LocomoQa[]
}

type RunOptions = BaseBenchOptions

async function main(): Promise<void> {
  const opts = parseOptions()

  if (!(await fileExists(opts.datasetPath))) {
    log.error('dataset not found', { path: opts.datasetPath })
    console.error(
      `\nLoCoMo dataset not found at: ${opts.datasetPath}\n\n` +
        `Set LOCOMO_DATASET or pass --dataset=<path>. Example sources:\n` +
        `  HuggingFace:  snap-stanford/LoCoMo, snapdragon/locomo10\n` +
        `  Local:        ./benchmarks/data/locomo10.json\n`,
    )
    process.exit(2)
  }

  const dataset = await loadDataset(opts.datasetPath)
  log.info('dataset loaded', {
    path: opts.datasetPath,
    conversations: dataset.length,
    limit: opts.limit ?? 'all',
  })

  await prepareWorkDir(opts.workDir, opts.fresh)

  const embedder = await createEmbedder({
    ...(opts.provider !== 'auto' ? { forceProvider: opts.provider } : {}),
  })

  const benchBackend = await createBenchBackend(opts)
  log.info('backend configured', { backend: benchBackend.description })

  const store = new MemoryStore({
    root: opts.workDir,
    embedder,
    // Point atomic index at a file that won't exist — LoCoMo is pure vector.
    atomicIndexPath: join(opts.workDir, 'gks', '00_index', 'atomic_index.jsonl'),
    vectorScoreThreshold: opts.scoreThreshold,
    ...(benchBackend.factory ? { vectorBackend: benchBackend.factory } : {}),
    ...(opts.rerank ? { reranker: opts.rerank } : {}),
  })
  await store.init()

  const conversations = opts.limit ? dataset.slice(0, opts.limit) : dataset

  const aggregate = {
    convs: 0,
    qaTotal: 0,
    evidenceTop1: 0,
    evidenceTopK: 0,
    answerInTopK: 0,
    ingestMs: 0,
    recallMs: 0,
  }

  for (const conv of conversations) {
    const convMetrics = await runConversation(store, conv, opts)
    aggregate.convs += 1
    aggregate.qaTotal += convMetrics.qaCount
    aggregate.evidenceTop1 += convMetrics.evidenceTop1
    aggregate.evidenceTopK += convMetrics.evidenceTopK
    aggregate.answerInTopK += convMetrics.answerInTopK
    aggregate.ingestMs += convMetrics.ingestMs
    aggregate.recallMs += convMetrics.recallMs

    log.info('conversation done', {
      conv: conv.id,
      qa: convMetrics.qaCount,
      top1: pct(convMetrics.evidenceTop1, convMetrics.qaCount),
      topK: pct(convMetrics.evidenceTopK, convMetrics.qaCount),
    })
  }

  const report = {
    dataset: opts.datasetPath,
    embedder: { provider: embedder.provider, model: embedder.model, dim: embedder.dimension },
    topK: opts.topK,
    scoreThreshold: opts.scoreThreshold,
    conversations: aggregate.convs,
    qa_total: aggregate.qaTotal,
    evidence_top1: aggregate.evidenceTop1,
    evidence_topk: aggregate.evidenceTopK,
    answer_in_topk: aggregate.answerInTopK,
    evidence_top1_pct: pct(aggregate.evidenceTop1, aggregate.qaTotal),
    evidence_topk_pct: pct(aggregate.evidenceTopK, aggregate.qaTotal),
    answer_in_topk_pct: pct(aggregate.answerInTopK, aggregate.qaTotal),
    avg_ingest_ms_per_conv: round2(aggregate.ingestMs / Math.max(1, aggregate.convs)),
    avg_recall_ms_per_qa: round2(aggregate.recallMs / Math.max(1, aggregate.qaTotal)),
  }

  printReport('LoCoMo Benchmark Report', report)

  await benchBackend.dispose()
}

async function runConversation(
  store: MemoryStore,
  conv: LocomoConversation,
  opts: RunOptions,
): Promise<{
  qaCount: number
  evidenceTop1: number
  evidenceTopK: number
  answerInTopK: number
  ingestMs: number
  recallMs: number
}> {
  // Each conversation gets an isolated namespace so we don't leak between convs.
  const namespace = { session_id: conv.id }

  // Clear the vector store for this run to prevent cross-conversation bleed.
  const vStore = await store.getVectorStore('atomic')
  await vStore.clear()

  const ingestStart = Date.now()
  for (const sess of conv.sessions) {
    for (const msg of sess.messages) {
      if (!msg.text?.trim()) continue
      await retain(store, {
        content: msg.text,
        metadata: {
          path: `${conv.id}/${sess.session_id}`,
          session_id: conv.id,
          user_id: msg.speaker,
          tags: ['locomo', sess.session_id],
        },
      })
    }
  }
  const ingestMs = Date.now() - ingestStart

  let evidenceTop1 = 0
  let evidenceTopK = 0
  let answerInTopK = 0
  const recallStart = Date.now()

  for (const q of conv.qa) {
    const res = await recall(store, q.question, {
      strategy: 'vector',
      topK: opts.topK,
      scoreThreshold: opts.scoreThreshold,
      namespace,
    })
    const hits = res.hits

    const evidenceList = q.evidence ?? []
    const hitsTexts = hits.map((h) => normalizeText(h.snippet))
    const normalizedAnswer = normalizeText(q.answer ?? '')

    // Evidence@1 / Evidence@K: does any hit contain any piece of evidence?
    const match1 =
      hits.length > 0 &&
      evidenceList.some((ev) => containsSnippet(hitsTexts[0] ?? '', ev))
    const matchK = evidenceList.some((ev) =>
      hitsTexts.some((t) => containsSnippet(t, ev)),
    )
    if (match1) evidenceTop1 += 1
    if (matchK) evidenceTopK += 1

    // Answer surface check: is the gold answer present in any top-K snippet?
    if (normalizedAnswer && hitsTexts.some((t) => containsSnippet(t, normalizedAnswer))) {
      answerInTopK += 1
    }
  }
  const recallMs = Date.now() - recallStart

  return {
    qaCount: conv.qa.length,
    evidenceTop1,
    evidenceTopK,
    answerInTopK,
    ingestMs,
    recallMs,
  }
}

// ─── parsing / loading ─────────────────────────────────────────────────────

async function loadDataset(path: string): Promise<LocomoConversation[]> {
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  return normalizeDataset(parsed)
}

function normalizeDataset(parsed: unknown): LocomoConversation[] {
  const arr = pickArray(parsed, ['conversations', 'samples', 'sample'])
  const out: LocomoConversation[] = []
  arr.forEach((item, i) => {
    const normalized = normalizeConversation(item, i)
    if (normalized) out.push(normalized)
  })
  return out
}

function normalizeConversation(item: unknown, i: number): LocomoConversation | null {
  if (!isRecord(item)) return null
  const id =
    (item['id'] as string | undefined) ??
    (item['sample_id'] as string | undefined) ??
    `conv-${i.toString().padStart(4, '0')}`

  const sessions = normalizeSessions(item)
  const qa = normalizeQa(item)
  if (sessions.length === 0 || qa.length === 0) return null
  return { id, sessions, qa }
}

function normalizeSessions(item: Record<string, unknown>): LocomoSession[] {
  // Common: item.sessions = [{session_id, messages:[...]}]
  if (Array.isArray(item['sessions'])) {
    return (item['sessions'] as unknown[])
      .map((s, i) => {
        if (!isRecord(s)) return null
        const sessionId =
          (s['session_id'] as string | undefined) ?? `s${(i + 1).toString()}`
        const msgs = Array.isArray(s['messages'])
          ? (s['messages'] as unknown[]).map(normalizeMessage).filter(isPresent)
          : []
        return { session_id: sessionId, messages: msgs }
      })
      .filter(isPresent)
  }
  // Fallback: item.conversation = { session_1:[...], session_2:[...] }
  if (isRecord(item['conversation'])) {
    const conv = item['conversation'] as Record<string, unknown>
    return Object.entries(conv)
      .filter(([_, v]) => Array.isArray(v))
      .map(([k, v]) => ({
        session_id: k,
        messages: (v as unknown[]).map(normalizeMessage).filter(isPresent),
      }))
  }
  return []
}

function normalizeMessage(m: unknown): LocomoMessage | null {
  if (!isRecord(m)) return null
  const speaker =
    (m['speaker'] as string | undefined) ??
    (m['role'] as string | undefined) ??
    (m['user'] as string | undefined) ??
    'unknown'
  const text =
    (m['text'] as string | undefined) ??
    (m['content'] as string | undefined) ??
    (m['message'] as string | undefined) ??
    ''
  if (!text) return null
  const base: LocomoMessage = { speaker, text }
  const timestamp = m['timestamp'] as string | undefined
  if (timestamp) base.timestamp = timestamp
  return base
}

function normalizeQa(item: Record<string, unknown>): LocomoQa[] {
  const src = (item['qa'] ?? item['questions'] ?? item['questionAnswerPairs']) as unknown
  if (!Array.isArray(src)) return []
  return src
    .map((q) => {
      if (!isRecord(q)) return null
      const question = (q['question'] as string | undefined) ?? (q['q'] as string | undefined)
      const answer = (q['answer'] as string | undefined) ?? (q['a'] as string | undefined) ?? ''
      if (!question) return null
      const evidence = Array.isArray(q['evidence'])
        ? (q['evidence'] as unknown[]).filter((e): e is string => typeof e === 'string')
        : typeof q['evidence'] === 'string'
          ? [q['evidence'] as string]
          : []
      const category = q['category'] as string | undefined
      const out: LocomoQa = { question, answer, evidence }
      if (category) out.category = category
      return out
    })
    .filter(isPresent)
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseOptions(): RunOptions {
  const { base } = parseBaseBenchArgs({
    datasetEnvVar: 'LOCOMO_DATASET',
    datasetDefaultPath: './benchmarks/data/locomo10.json',
    workDirDefault: './benchmarks/.cache/locomo-run',
    topKDefault: 10,
    topKEnvVar: 'LOCOMO_TOPK',
    thresholdDefault: 0.25,
    thresholdEnvVar: 'LOCOMO_THRESHOLD',
  })
  return base
}

main().catch((err) => {
  log.error('benchmark failed', { err: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
