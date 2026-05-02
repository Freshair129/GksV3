#!/usr/bin/env tsx
/**
 * GKS v3 quickstart — local-first profile.
 *
 * Demonstrates the entire retain → recall → reflect pipeline running
 * without any cloud API key, on commodity hardware (8–12 GB VRAM target).
 * Pairs:
 *
 *   • nomic-embed-text-v1.5      — local embedder (already default; auto-falls
 *                                  back to mock if HF download is blocked)
 *   • bge-reranker-v2-m3         — local cross-encoder reranker via
 *                                  @huggingface/transformers
 *   • qwen2.5:7b-instruct        — consolidator + TLDR generator via Ollama
 *                                  (or any OpenAI-compatible local endpoint)
 *   • summary_tldr               — pre-computed dense snippets at retain time
 *   • snippetMaxChars=0          — index-only recall mode (~80% token cut)
 *
 * Run with the deterministic mock stack (no infra required):
 *
 *   npx tsx examples/quickstart-local.ts
 *
 * Run against a real Ollama instance (pull the model first):
 *
 *   ollama pull qwen2.5:7b-instruct
 *   GKS_LLM_BASE_URL=http://localhost:11434/v1 \
 *   GKS_LLM_MODEL=qwen2.5:7b-instruct \
 *     npx tsx examples/quickstart-local.ts --use-ollama
 *
 * Run with a downloaded BGE reranker (first call pulls ~600 MB):
 *
 *   npx tsx examples/quickstart-local.ts --use-bge-reranker
 *
 * Combine for the full local-first experience:
 *
 *   ollama pull qwen2.5:7b-instruct
 *   GKS_LLM_BASE_URL=http://localhost:11434/v1 \
 *     npx tsx examples/quickstart-local.ts --use-ollama --use-bge-reranker
 *
 * The script always succeeds — `--use-ollama` and `--use-bge-reranker`
 * gate optional infrastructure; absent infra falls back to heuristic /
 * lexical paths so CI runs reliably.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  CommunityCache,
  MemoryStore,
  createOpenAICompatibleClient,
  createLlmTldrGenerator,
  heuristicTldrGenerator,
  mockEmbedder,
  summarizeCommunity,
  type CommunityAtomic,
  type TldrGenerator,
} from '../src/memory/index.js'
import { retain, recall } from '../src/memory/api.js'
import type { AtomicEntry, AtomicNote } from '../src/memory/types.js'

interface CliFlags {
  useOllama: boolean
  useBgeReranker: boolean
  keep: boolean
}

function parseCli(): CliFlags {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'use-ollama': { type: 'boolean' },
      'use-bge-reranker': { type: 'boolean' },
      keep: { type: 'boolean' },
    },
  })
  return {
    useOllama: values['use-ollama'] === true,
    useBgeReranker: values['use-bge-reranker'] === true,
    keep: values.keep === true,
  }
}

async function main(): Promise<void> {
  const args = parseCli()

  const root = await mkdtemp(join(tmpdir(), 'gks-quickstart-local-'))
  log(1, `workspace: ${root}`)

  // ── Build the TLDR generator ──────────────────────────────────────────
  // Heuristic by default — zero-LLM-cost, deterministic. With --use-ollama
  // we wrap a local SLM via the OpenAI-compatible client and let it fall
  // back to heuristic on error.
  let tldrGenerator: TldrGenerator
  if (args.useOllama) {
    const client = createOpenAICompatibleClient()
    tldrGenerator = createLlmTldrGenerator({ client })
    log(1, `tldr generator: ${tldrGenerator.name} (LLM-backed)`)
  } else {
    tldrGenerator = heuristicTldrGenerator()
    log(1, `tldr generator: ${tldrGenerator.name} (deterministic, no LLM)`)
  }

  // ── Build the MemoryStore ────────────────────────────────────────────
  // Deterministic mock embedder so the demo is reproducible. In production
  // you'd omit `embedder` to let GKS auto-pick nomic (local, ~550MB) →
  // ollama → openai → mock.
  const embedder = mockEmbedder(64)

  const store = new MemoryStore({
    root,
    embedder,
    reranker: args.useBgeReranker
      ? {
          backend: 'transformers',
          model: 'Xenova/bge-reranker-v2-m3',
          alpha: 0.6,
          normalize: true,
          limit: 20,
        }
      : { backend: 'lexical', alpha: 0.6, normalize: true, limit: 20 },
  })
  await store.init()
  log(1, `reranker: ${args.useBgeReranker ? 'transformers (BGE cross-encoder)' : 'lexical (BM25-lite)'}`)

  // ── 1. Retain a few atoms WITH summary_tldr generated ─────────────────
  log(1, 'retaining facts with generateTldr=true ...')
  const facts = [
    {
      title: 'Bi-temporal conflict resolution',
      body:
        'GKS marks a doc as superseded by setting valid_to to the moment a ' +
        'contradicting fact was retained. The old doc remains in the store but ' +
        'recall filters it out by default. This preserves the audit trail.',
      path: 'fact-bitemporal.md',
    },
    {
      title: 'Local-first embedder',
      body:
        'nomic-embed-text-v1.5 runs locally via @huggingface/transformers, ' +
        'producing 768-dim vectors with no API call. Multilingual incl. Thai. ' +
        'First call downloads ~550MB; subsequent embeds are <100ms.',
      path: 'fact-embedder.md',
    },
    {
      title: 'Cross-encoder reranker',
      body:
        'BGE-reranker-v2-m3 reads (query, document) jointly and emits one ' +
        'relevance logit per pair. MTEB shows +15-25% NDCG@10 over BM25. ' +
        'Loaded lazily on first .score() call — no cost when disabled.',
      path: 'fact-reranker.md',
    },
  ]

  for (const fact of facts) {
    const result = await retain(store, {
      content: fact.body,
      metadata: { path: fact.path, title: fact.title },
      generateTldr: true,
      tldrGenerator,
    })
    log(2, `retained ${fact.path} (doc ${result.vectorDocId?.slice(0, 8)}…)`)
  }

  // ── 2. Recall: default snippet (with TLDR populated) ─────────────────
  log(1, 'recall("reranker latency") with default snippet (TLDR preferred) ...')
  const defaultRes = await recall(store, 'reranker latency', {
    topK: 3,
    scoreThreshold: -1,
  })
  for (const hit of defaultRes.hits) {
    log(3, `${hit.source.padEnd(8)} ${hit.score.toFixed(3)} "${truncate(hit.snippet, 80)}"`)
  }
  const totalCharsDefault = defaultRes.hits.reduce((s, h) => s + h.snippet.length, 0)

  // ── 3. Recall: index-only mode (snippetMaxChars=0) ───────────────────
  log(1, 'recall("reranker latency") with snippetMaxChars=0 (index-only) ...')
  const indexRes = await recall(store, 'reranker latency', {
    topK: 3,
    scoreThreshold: -1,
    snippetMaxChars: 0,
  })
  for (const hit of indexRes.hits) {
    log(3, `${hit.source.padEnd(8)} ${hit.score.toFixed(3)} "${hit.snippet}"`)
  }
  const totalCharsIndex = indexRes.hits.reduce((s, h) => s + h.snippet.length, 0)

  // ── 4. Compare token budgets ─────────────────────────────────────────
  const reductionPct =
    totalCharsDefault > 0 ? Math.round(((totalCharsDefault - totalCharsIndex) / totalCharsDefault) * 100) : 0
  log(1, 'token-budget summary:')
  log(2, `default mode (TLDR snippets): ${totalCharsDefault} chars (~${Math.ceil(totalCharsDefault / 4)} tokens)`)
  log(2, `index-only mode (titles):     ${totalCharsIndex} chars (~${Math.ceil(totalCharsIndex / 4)} tokens)`)
  log(2, `reduction: ${reductionPct}%`)

  // ── 5. Tip: the lazy-load pattern ────────────────────────────────────
  log(1, 'lazy-load pattern (Anthropic Skills style):')
  log(2, '1. recall(query, { snippetMaxChars: 0 })  → cheap metadata-only hits')
  log(2, '2. agent picks the relevant id            → rank by score + title')
  log(2, '3. lookup(id)                              → load full body only when needed')

  // ── 6. Higher-order summary across a small atom community ───────────
  // Demo of summarizeCommunity (GraphRAG-style synthesis). For brevity,
  // we wire an in-memory CommunityAtomic stub here rather than promoting
  // atoms into gks/ + rebuilding the index. In a real codebase you
  // call store.summarizeCommunity({...}) which uses the indexed
  // gks/ tree directly.
  log(1, 'community summary (GraphRAG-style synthesis over a crosslinked chain) ...')
  const stubAtoms: AtomicEntry[] = [
    {
      id: 'CONCEPT--DEMO',
      phase: 1,
      type: 'concept',
      status: 'stable',
      vault_id: 'default',
      path: 'concept/CONCEPT--DEMO.md',
      title: 'Demo concept',
      summary_tldr: 'The demo concept introduces the framing for this quickstart chain.',
    },
    {
      id: 'ADR--DEMO',
      phase: 2,
      type: 'adr',
      status: 'stable',
      vault_id: 'default',
      path: 'adr/ADR--DEMO.md',
      title: 'Demo ADR',
      summary_tldr: 'The ADR records the decision and pins the architectural shape.',
      crosslinks: { parent_concept: ['CONCEPT--DEMO'] },
    },
    {
      id: 'FEAT--DEMO',
      phase: 2,
      type: 'feat',
      status: 'stable',
      vault_id: 'default',
      path: 'feat/FEAT--DEMO.md',
      title: 'Demo feature',
      summary_tldr: 'The feature delivers the user-facing behaviour described in the ADR.',
      crosslinks: { parent_adr: ['ADR--DEMO'] },
    },
  ]
  const byId = new Map(stubAtoms.map((e) => [e.id, e]))
  const stubAtomic: CommunityAtomic = {
    getEntry: (id) => byId.get(id),
    async lookup(id) {
      const e = byId.get(id)
      if (!e) return null
      const note: AtomicNote = { ...e, body: e.summary_tldr ?? '' }
      return note
    },
  }
  const cache = new CommunityCache()

  const community = await summarizeCommunity(
    { atomic: stubAtomic, cache },
    {
      seed: 'FEAT--DEMO',
      hops: 2, // FEAT → ADR → CONCEPT
      generator: tldrGenerator,
    },
  )
  log(2, `members: ${community.members.join(', ')}`)
  log(2, `generator: ${community.generator}`)
  log(2, `cached: ${community.cached}, truncated: ${community.truncated}`)
  log(2, `input tokens (est.): ~${community.inputTokensEstimate}`)
  log(2, `synthesis (first 200 chars): "${truncate(community.summary, 200)}"`)

  // Second call with identical args hits the LRU cache.
  const cached = await summarizeCommunity(
    { atomic: stubAtomic, cache },
    { seed: 'FEAT--DEMO', hops: 2, generator: tldrGenerator },
  )
  log(2, `cache hit on identical args: cached=${cached.cached}`)

  // ── cleanup ───────────────────────────────────────────────────────────
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
  console.error('quickstart-local failed:', err)
  process.exit(1)
})
