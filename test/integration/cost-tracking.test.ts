/**
 * Cost / token tracking integration test: configure a CostTracker on the
 * MemoryStore, drive a few retains + a recall, then endSession() and
 * verify session.json carries the cost breakdown.
 *
 * Mock embedder produces 0-USD entries (it has no pricing) — we still
 * verify that token counts get accumulated and a row is written, since
 * Ollama would behave the same way (estimated tokens, $0).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryStore,
  endSession,
  mockEmbedder,
  startSession,
} from '../../src/memory/index.js'
import { recall, retain } from '../../src/memory/api.js'

describe('cost tracking — end-to-end', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('CostTracker accumulates embedder calls; endSession flushes to session.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-cost-'))
    cleanup.push(root)

    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
      cost: {},
    })
    await store.init()
    const start = await startSession(store)

    // Three retain + one recall — each runs the embedder.
    await retain(store, { content: 'fact one', metadata: { path: '1.md' } })
    await retain(store, { content: 'fact two', metadata: { path: '2.md' } })
    await retain(store, { content: 'fact three', metadata: { path: '3.md' } })
    await recall(store, 'fact', { strategy: 'vector', scoreThreshold: -1, topK: 3 })

    // Tracker has accumulated entries.
    const summary = store.costTracker!.summary()
    expect(summary.total.calls).toBeGreaterThanOrEqual(4)
    expect(summary.total.input_tokens).toBeGreaterThan(0)
    // Mock embedder has $0 pricing — usd should be 0 but tokens nonzero.
    expect(summary.total.usd).toBe(0)
    expect(summary.byModel[0]!.provider).toBe('mock')

    const end = await endSession(store, start.session)
    const sessionFile = await readFile(end.sessionFilePath, 'utf8')
    const parsed = JSON.parse(sessionFile) as {
      tokens_total?: number
      cost_usd?: number
      cost_breakdown?: Array<{ provider: string; calls: number }>
    }

    expect(parsed.tokens_total).toBeGreaterThan(0)
    expect(parsed.cost_usd).toBe(0)
    expect(parsed.cost_breakdown).toBeDefined()
    expect(parsed.cost_breakdown![0]!.provider).toBe('mock')
  })

  it('cost:false leaves costTracker null and session.json without cost fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-nocost-'))
    cleanup.push(root)

    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
      cost: false,
    })
    await store.init()
    const start = await startSession(store)
    await retain(store, { content: 'x' })

    expect(store.costTracker).toBeNull()
    const end = await endSession(store, start.session)
    const parsed = JSON.parse(await readFile(end.sessionFilePath, 'utf8')) as Record<string, unknown>
    expect('cost_breakdown' in parsed).toBe(false)
  })

  it('user-supplied pricing flows through to the session summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-cost-px-'))
    cleanup.push(root)

    // Override pricing for the mock model so we can assert non-zero USD.
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
      cost: {
        pricing: {
          'mock:mock-sha256-d32': { inputPerMTok: 1.0, outputPerMTok: 0 },
        },
      },
    })
    await store.init()
    const start = await startSession(store)
    await retain(store, { content: 'x'.repeat(3500) }) // ~1000 tokens
    const end = await endSession(store, start.session)
    const parsed = JSON.parse(await readFile(end.sessionFilePath, 'utf8')) as {
      cost_usd: number
    }
    expect(parsed.cost_usd).toBeGreaterThan(0)
  })
})
