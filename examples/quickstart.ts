#!/usr/bin/env tsx
/**
 * GKS v3 quickstart — end-to-end walkthrough.
 *
 * Exercises every major API surface in one script so you can eyeball the full
 * loop working:
 *
 *   1.  Start a session (verifies manifest + embedder + Obsidian ping)
 *   2.  Retain a handful of facts (multi-layer writes, conflict detection)
 *   3.  Supersede a prior fact (bi-temporal valid_from / valid_to)
 *   4.  Recall across all four sources (atomic + vector + episodic + obsidian)
 *   5.  Propose an atomic note through the Inbound queue
 *   6.  End the session (trace flush, optional consolidation)
 *   7.  Graph traversal demo (temporal asOf queries)
 *
 * Runs with the deterministic mock embedder by default so no network / infra
 * is required. Swap in a real Ollama / OpenAI / Anthropic stack via env vars:
 *
 *   GKS_EMBEDDER=ollama OLLAMA_BASE_URL=http://localhost:11434 \
 *     npx tsx examples/quickstart.ts
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/quickstart.ts --consolidate
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  MemoryStore,
  GraphStore,
  createMockObsidianAdapter,
  createLlmExtractor,
  createAnthropicClient,
  mockEmbedder,
  startSession,
  endSession,
} from '../src/memory/index.js'
import { retain, recall, reflect } from '../src/memory/api.js'

function parseCli(): { useRealEmbedder: boolean; consolidate: boolean; keep: boolean } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'real-embedder': { type: 'boolean' },
      consolidate: { type: 'boolean' },
      keep: { type: 'boolean' },
    },
  })
  return {
    useRealEmbedder: values['real-embedder'] === true || process.env['GKS_EMBEDDER'] === 'ollama' || process.env['GKS_EMBEDDER'] === 'openai',
    consolidate: values.consolidate === true && !!process.env['ANTHROPIC_API_KEY'],
    keep: values.keep === true,
  }
}

async function main(): Promise<void> {
  const args = parseCli()

  // Temp root so the quickstart doesn't pollute your repo's .brain/ dir.
  const root = await mkdtemp(join(tmpdir(), 'gks-quickstart-'))
  log(1, `workspace: ${root}`)

  const embedder = args.useRealEmbedder ? undefined : mockEmbedder(64)

  // Obsidian mock: a tiny vault that MemoryStore can enrich recall with.
  const obsidian = createMockObsidianAdapter({
    notes: [
      {
        path: 'Concepts/EvaTriBrain.md',
        title: 'EVA Tri-Brain',
        body: 'Three cognitive modules: Cortex (planning), Motor (code gen), Limbic (intent/affect).',
        tags: ['architecture', 'core'],
        backlinks: [],
        outlinks: ['Cortex', 'Motor', 'Limbic'],
      },
      {
        path: 'Concepts/GKSv3.md',
        title: 'GKS v3',
        body: 'A four-layer memory fabric: Atomic, Vector, Obsidian, Episodic. Built to the EVA Tri-Brain Blueprint.',
        tags: ['architecture', 'memory'],
        backlinks: [],
        outlinks: ['EvaTriBrain'],
      },
    ],
  })

  const store = new MemoryStore({
    root,
    ...(embedder ? { embedder } : {}),
    obsidian,
    reranker: { backend: 'lexical', alpha: 0.6, normalize: true, limit: 20 },
  })
  await store.init()

  // ── 1. Start session ───────────────────────────────────────────────────
  const startReport = await startSession(store, {
    participants: ['user:demo', 'agent:gks-quickstart'],
    tags: ['quickstart'],
  })
  log(1, `session started: ${startReport.session.id}`)
  log(2, `atomic notes loaded: ${startReport.atomicLoaded}`)
  log(2, `embedder: ${startReport.embedder.provider} / ${startReport.embedder.model} (dim ${startReport.embedder.dimension})`)
  log(2, `obsidian reachable: ${startReport.obsidianReachable}`)
  if (startReport.warnings.length) log(2, `warnings: ${startReport.warnings.join('; ')}`)

  // ── 2. Retain a handful of facts ───────────────────────────────────────
  log(1, 'retaining facts...')
  await retain(store, {
    content: 'User prefers dark mode in the CLI UI.',
    metadata: { path: 'fact-1.md', tags: ['preference'] },
    sessionId: startReport.session.id,
  })
  await retain(store, {
    content: 'The Cortex module runs on Claude Opus 4.7 by default.',
    metadata: { path: 'fact-2.md', tags: ['config'] },
    sessionId: startReport.session.id,
  })
  const colorFirst = await retain(store, {
    content: 'User favorite color is green.',
    metadata: { path: 'fact-3.md', tags: ['preference'] },
    sessionId: startReport.session.id,
  })
  log(2, 'retained 3 facts')

  // ── 3. Supersede a fact (bi-temporal) ──────────────────────────────────
  log(1, 'superseding an earlier fact...')
  const colorSecond = await retain(store, {
    content: 'User favorite color is green.',          // same content ⇒ true-duplicate path
    conflictPolicy: 'supersede',
    conflictThreshold: 0.95,
    validFrom: new Date().toISOString(),
    metadata: { path: 'fact-3-updated.md' },
    sessionId: startReport.session.id,
  })
  log(2, `new doc: ${colorSecond.vectorDocId}; conflicts flagged: ${colorSecond.conflicts.length}`)
  void colorFirst

  // ── 4. Recall across all four sources ──────────────────────────────────
  log(1, 'recall("tri-brain architecture") across atomic + vector + episodic + obsidian...')
  const recallResult = await recall(store, 'tri-brain architecture', {
    strategy: 'multi',
    topK: 5,
    scoreThreshold: -1,
  })
  log(2, `strategy=${recallResult.strategy} tookMs=${recallResult.tookMs}`)
  for (const hit of recallResult.hits.slice(0, 5)) {
    log(3, `${hit.source.padEnd(8)} score=${hit.score.toFixed(3)} "${truncate(hit.snippet, 60)}"`)
  }

  // ── 5. Propose to the Inbound queue ────────────────────────────────────
  log(1, 'proposing an atomic note via the inbound queue (human review)...')
  const receipt = await store.proposeInbound({
    proposed_id: 'INSIGHT--USER-PREFERS-DARK-MODE',
    phase: 1,
    type: 'insight',
    title: 'User prefers dark mode',
    body: 'Observed the user select dark mode in the CLI UI during this session.',
    source_session: startReport.session.id,
    confidence: 0.8,
  })
  log(2, `inbound artifact: ${receipt.path}`)
  log(2, `reviewId:         ${receipt.reviewId}`)

  // Append trace steps so consolidation has something to chew on.
  for (const step of [
    { kind: 'user' as const, content: 'Walk me through GKS v3 layers' },
    { kind: 'agent' as const, content: 'Atomic (exact-id), Vector (semantic), Obsidian (graph), Episodic (session). Retain/Recall/Reflect bridges them.' },
    { kind: 'user' as const, content: 'And when does consolidation run?' },
    { kind: 'agent' as const, content: 'On session end, or when trace > 30 messages and duration > 60 min.' },
  ]) {
    await store.appendTrace(startReport.session.id, step)
  }

  // ── 6. End session ─────────────────────────────────────────────────────
  log(1, 'ending session...')
  const endReport = await endSession(store, startReport.session, {
    forceConsolidate: args.consolidate,
    ...(args.consolidate
      ? {
          extractor: createLlmExtractor({
            client: createAnthropicClient(),
            fallback: {
              async extract() {
                return {
                  summary: '(heuristic fallback)', tags: [], outcomes: [],
                  emotionSummary: 'neutral', linkedAtoms: [], proposals: [],
                }
              },
            },
          }),
        }
      : {}),
  })
  log(2, `trace steps: ${endReport.traceSteps}`)
  log(2, `consolidated: ${endReport.consolidated} (triggered=${endReport.triggered})`)
  if (endReport.reflect) {
    log(2, `summary: "${truncate(endReport.reflect.memory.summary, 100)}"`)
    log(2, `proposals: ${endReport.reflect.proposals.length}`)
  }

  // ── 7. Graph traversal demo ────────────────────────────────────────────
  log(1, 'temporal graph demo...')
  const graph = new GraphStore()
  await graph.load()
  await graph.addNode({ id: 'u:demo', labels: ['User'], props: { name: 'Demo User' } })
  await graph.addNode({ id: 'city:paris', labels: ['City'], props: { name: 'Paris' } })
  await graph.addNode({ id: 'city:berlin', labels: ['City'], props: { name: 'Berlin' } })
  await graph.addEdge({ from: 'u:demo', to: 'city:paris', rel: 'LIVES_IN', valid_from: '2022-01-01T00:00:00Z' })
  await graph.addEdge({ from: 'u:demo', to: 'city:berlin', rel: 'LIVES_IN', valid_from: '2024-06-01T00:00:00Z', supersede: true })

  const in2023 = graph.query({ from: 'u:demo', rel: 'LIVES_IN', asOf: '2023-06-01T00:00:00Z' })
  const today = graph.query({ from: 'u:demo', rel: 'LIVES_IN' })
  log(2, `asOf 2023-06-01: user lived in ${in2023.map((e) => e.to).join(', ')}`)
  log(2, `current:         user lives in  ${today.map((e) => e.to).join(', ')}`)

  // ── cleanup ────────────────────────────────────────────────────────────
  if (args.keep) {
    log(1, `workspace kept at ${root} (--keep)`)
  } else {
    await rm(root, { recursive: true, force: true })
    log(1, 'workspace cleaned up')
  }
}

function log(indent: number, msg: string): void {
  const prefix = '  '.repeat(Math.max(0, indent - 1))
  const bullet = indent === 1 ? '▸' : indent === 2 ? '·' : '  '
  console.log(`${prefix}${bullet} ${msg}`)
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

main().catch((err) => {
  console.error('quickstart failed:', err)
  process.exit(1)
})
