#!/usr/bin/env tsx
/**
 * Local-first profile smoke test against a real Ollama instance.
 *
 * Exercises the full local pipeline (no API keys, no cloud calls) and
 * fails loudly if any layer is broken or misconfigured. Designed to run
 * locally on a dev box with Ollama installed; CI uses the mock paths
 * (covered by `npm run quickstart:local` without flags).
 *
 * Prerequisites:
 *   1. Ollama running at http://localhost:11434
 *   2. `ollama pull qwen2.5:7b-instruct` (or any chat-capable model)
 *   3. Optional: `ollama pull bge-m3` if you also want to exercise the
 *      Ollama embedder path; otherwise the local nomic embedder is used.
 *
 * Run:
 *   GKS_LLM_BASE_URL=http://localhost:11434/v1 \
 *   GKS_LLM_MODEL=qwen2.5:7b-instruct \
 *     npx tsx examples/smoke-ollama.ts
 *
 * What it checks (each step prints OK / FAIL):
 *   1. OpenAI-compatible client can hit /v1/chat/completions
 *   2. Heuristic TLDR generator works (no LLM)
 *   3. LLM TLDR generator hits Ollama and returns non-empty text
 *   4. Community summarizer composes both paths
 *   5. Disk-tier cache survives a process restart (writes + reads)
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — at least one check failed; see stderr for details
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CommunityCache,
  DiskCommunityCache,
  TieredCommunityCache,
  createLlmTldrGenerator,
  createOpenAICompatibleClient,
  heuristicTldrGenerator,
  summarizeCommunity,
  type CommunityAtomic,
} from '../src/memory/index.js'
import type { AtomicEntry, AtomicNote } from '../src/memory/types.js'

const FAILURES: string[] = []

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`)
}
function fail(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ? String(err) : ''
  const text = detail ? `${msg} — ${detail}` : msg
  FAILURES.push(text)
  console.error(`  ✗ ${text}`)
}
function step(n: number, label: string): void {
  console.log(`\n[${n}] ${label}`)
}

function buildFixture(): { atomic: CommunityAtomic } {
  const entries: AtomicEntry[] = [
    {
      id: 'CONCEPT--LOCAL-FIRST',
      phase: 1,
      type: 'concept',
      status: 'stable',
      vault_id: 'default',
      path: 'concept/CONCEPT--LOCAL-FIRST.md',
      title: 'Local-first profile',
      summary_tldr:
        'Run the full GKS pipeline (embedder, reranker, consolidator) on commodity hardware with no API keys.',
    },
    {
      id: 'ADR--LOCAL-FIRST',
      phase: 2,
      type: 'adr',
      status: 'stable',
      vault_id: 'default',
      path: 'adr/ADR--LOCAL-FIRST.md',
      title: 'Local-first ADR',
      summary_tldr: 'Default to local nomic + BGE + Qwen2.5-7B; cloud is opt-in.',
      crosslinks: { parent_concept: ['CONCEPT--LOCAL-FIRST'] },
    },
    {
      id: 'FEAT--LOCAL-FIRST',
      phase: 2,
      type: 'feat',
      status: 'stable',
      vault_id: 'default',
      path: 'feat/FEAT--LOCAL-FIRST.md',
      title: 'Local-first feature',
      summary_tldr: 'CLI + MCP + slash commands all run end-to-end on local stack.',
      crosslinks: { parent_adr: ['ADR--LOCAL-FIRST'] },
    },
  ]
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    atomic: {
      getEntry: (id) => byId.get(id),
      async lookup(id) {
        const e = byId.get(id)
        if (!e) return null
        return { ...e, body: e.summary_tldr ?? '' } as AtomicNote
      },
    },
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env['GKS_LLM_BASE_URL'] ?? 'http://localhost:11434/v1'
  const model = process.env['GKS_LLM_MODEL'] ?? 'qwen2.5:7b-instruct'

  console.log(`Local-first smoke test`)
  console.log(`  endpoint: ${baseUrl}`)
  console.log(`  model:    ${model}`)

  // ── 1. OpenAI-compatible client hits /v1/chat/completions ─────────────
  step(1, 'OpenAI-compatible client → /v1/chat/completions')
  const client = createOpenAICompatibleClient({ baseUrl, model, timeoutMs: 60_000 })
  let llmReachable = false
  try {
    const out = await client.generate({
      system: 'Reply with a single word: OK.',
      user: 'ping',
      maxTokens: 8,
    })
    if (out && out.length > 0) {
      ok(`got reply (${out.length} chars)`)
      llmReachable = true
    } else {
      fail('client returned empty string')
    }
  } catch (err) {
    fail('client request failed (is Ollama running + model pulled?)', err)
  }

  // ── 2. Heuristic TLDR generator (no LLM) ───────────────────────────────
  step(2, 'Heuristic TLDR generator (no LLM)')
  try {
    const heur = heuristicTldrGenerator()
    const out = await heur.summarize(
      'This is the body of an atom. Heuristic strips frontmatter and headings.',
    )
    if (out.toLowerCase().includes('heuristic')) ok('heuristic produced output')
    else fail(`unexpected heuristic output: ${out}`)
  } catch (err) {
    fail('heuristic generator threw', err)
  }

  // ── 3. LLM TLDR generator → Ollama ────────────────────────────────────
  step(3, 'LLM TLDR generator → Ollama')
  if (!llmReachable) {
    fail('skipped (LLM not reachable in step 1)')
  } else {
    try {
      const gen = createLlmTldrGenerator({ client })
      const out = await gen.summarize(
        'Local-first profile means GKS runs on commodity hardware with no API keys. ' +
          'Embeddings via nomic, reranking via BGE, consolidation via Qwen2.5-7B over Ollama.',
      )
      if (out && out.length > 0) ok(`LLM TLDR (${out.length} chars): "${out.slice(0, 60)}..."`)
      else fail('LLM TLDR returned empty')
    } catch (err) {
      fail('LLM TLDR generator threw', err)
    }
  }

  // ── 4. Community summarizer end-to-end ─────────────────────────────────
  step(4, 'summarizeCommunity (LLM-backed)')
  if (!llmReachable) {
    fail('skipped (LLM not reachable)')
  } else {
    try {
      const { atomic } = buildFixture()
      const cache = new CommunityCache()
      const result = await summarizeCommunity(
        { atomic, cache },
        {
          seed: 'FEAT--LOCAL-FIRST',
          hops: 2,
          edges: ['parent_adr', 'parent_concept'],
          generator: createLlmTldrGenerator({ client }),
        },
      )
      if (result.members.length === 3 && result.summary.length > 0) {
        ok(`synthesised ${result.members.length} members (${result.inputTokensEstimate} input tokens est.)`)
      } else {
        fail(`unexpected community result: members=${result.members.length}`)
      }
    } catch (err) {
      fail('summarizeCommunity threw', err)
    }
  }

  // ── 5. Disk-tier cache survives across instances ──────────────────────
  step(5, 'DiskCommunityCache roundtrip')
  let cacheDir = ''
  try {
    cacheDir = await mkdtemp(join(tmpdir(), 'gks-smoke-disk-'))
    const writer = new DiskCommunityCache({ dir: cacheDir })
    await writer.set('smoke-key', {
      members: ['FEAT--LOCAL-FIRST'],
      summary: 'cached value',
      truncated: false,
      cached: false,
      inputTokensEstimate: 10,
      generator: 'heuristic',
    })

    const reader = new DiskCommunityCache({ dir: cacheDir })
    const got = await reader.get('smoke-key')
    if (got?.summary === 'cached value' && got.cached) ok('cache survived restart')
    else fail(`disk cache miss/corrupt: ${JSON.stringify(got)}`)

    // TieredCommunityCache promotes disk-hit to memory.
    const memTier = new CommunityCache()
    const tiered = new TieredCommunityCache(memTier, reader)
    const fromDisk = await tiered.get('smoke-key')
    if (fromDisk?.summary === 'cached value') ok('tiered: disk hit')
    else fail('tiered failed to read from disk')
    const inMem = memTier.get('smoke-key')
    if (inMem?.summary === 'cached value') ok('tiered: promoted to memory')
    else fail('tiered did not promote to memory')
  } catch (err) {
    fail('disk cache roundtrip threw', err)
  } finally {
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
  }

  // ── Result ─────────────────────────────────────────────────────────────
  console.log('')
  if (FAILURES.length === 0) {
    console.log('✅ all smoke checks passed')
    process.exit(0)
  } else {
    console.error(`❌ ${FAILURES.length} check(s) failed:`)
    for (const f of FAILURES) console.error(`   - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('smoke-ollama failed:', err)
  process.exit(1)
})
