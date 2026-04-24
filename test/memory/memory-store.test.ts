import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, cp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MemoryStore } from '../../src/memory/index.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'
import { retain, recall, reflect } from '../../src/memory/api.js'
import type { TraceStep } from '../../src/memory/types.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

async function withStore() {
  const root = await mkdtemp(join(tmpdir(), 'gks-root-'))
  // Copy the atomic fixtures into the temp root so the MemoryStore can resolve
  // paths exactly as it would in production.
  await mkdir(join(root, 'gks'), { recursive: true })
  await cp(FIXTURES, join(root, 'gks'), { recursive: true })

  const store = new MemoryStore({
    root,
    embedder: mockEmbedder(64),
  })
  await store.init()
  return { store, root }
}

describe('MemoryStore', () => {
  let cleanup: string[] = []

  beforeEach(() => {
    cleanup = []
  })

  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('lookup() resolves atomic IDs via the atomic layer', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)
    const note = await store.lookup('CONCEPT--EVA-TRI-BRAIN')
    expect(note?.title).toBe('EVA Tri-Brain')
  })

  it('retrieve() with atomic-ish query returns the exact note', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)
    const res = await store.retrieve('FRAME--TRI-BRAIN-ARCHITECTURE')
    expect(res.hits.some((h) => h.id === 'FRAME--TRI-BRAIN-ARCHITECTURE')).toBe(true)
    const hit = res.hits.find((h) => h.id === 'FRAME--TRI-BRAIN-ARCHITECTURE')!
    expect(hit.source).toBe('atomic')
  })

  it('retrieve() multi-strategy merges vector + atomic results and caps totals', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    await retain(store, { content: 'The Tri-Brain has three modules: Cortex, Motor, Limbic.', metadata: { path: 'fact-1.md' } })
    await retain(store, { content: 'Cortex handles reasoning and planning.', metadata: { path: 'fact-2.md' } })
    await retain(store, { content: 'Quantum mechanics has nothing to do with this.', metadata: { path: 'fact-3.md' } })

    const res = await recall(store, 'cortex reasoning', { topK: 5, scoreThreshold: -1 })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits.length).toBeLessThanOrEqual(5)
  })

  it('proposeInbound() writes to the inbound dir (not gks/)', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    const receipt = await store.proposeInbound({
      proposed_id: 'INSIGHT--TEST-FOO',
      phase: 1,
      type: 'insight',
      title: 'Test Foo',
      body: 'Body of the test insight.',
    })
    expect(receipt.path).toContain(join('.brain', 'msp', 'projects', 'evaAI', 'inbound'))
    expect(receipt.path).not.toContain(`${join(root, 'gks')}`)

    const md = await readFile(receipt.path, 'utf8')
    expect(md).toContain('proposed_id: INSIGHT--TEST-FOO')
    expect(md).toContain(receipt.reviewId)
  })

  it('appendTrace + reflect persists an episodic markdown file', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    const sessionId = 'MSP-SESS-test-001'
    const trace: TraceStep[] = [
      { t: new Date().toISOString(), session_id: sessionId, kind: 'user', content: 'Tell me about Cortex' },
      { t: new Date().toISOString(), session_id: sessionId, kind: 'agent', content: 'Cortex handles planning in the Tri-Brain system.' },
      { t: new Date().toISOString(), session_id: sessionId, kind: 'user', content: 'And Motor?' },
      { t: new Date().toISOString(), session_id: sessionId, kind: 'agent', content: 'Motor handles code generation through Qwen.' },
    ]
    for (const s of trace) await store.appendTrace(sessionId, s)

    const out = await reflect(
      store,
      {
        sessionId,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: new Date().toISOString(),
        participants: ['MSP-USR-BOSS', 'MSP-AGT-EVA-COWORK'],
        trace,
      },
      { persist: true },
    )

    expect(out.memory.session_id).toBe(sessionId)
    expect(out.memory.summary).toContain('Cortex')

    const dir = join(root, '.brain', 'msp', 'projects', 'evaAI', 'memory')
    const files = await readdir(dir)
    expect(files.some((f) => f.includes(sessionId))).toBe(true)
  })
})
