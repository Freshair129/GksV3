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

  it('retrieve() snippetMaxChars=0 returns title-only snippets (index-only mode)', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    const longBody =
      'This is a deliberately long body that, in the default snippet mode, ' +
      'gets truncated at 240 characters with a trailing ellipsis. We use ' +
      'this length specifically so we can verify that index-only mode returns ' +
      'something much shorter — the title or id — and never any of this body ' +
      'content. Lorem ipsum dolor sit amet, consectetur adipiscing elit.'
    await retain(store, {
      content: longBody,
      metadata: { path: 'long-fact.md', title: 'Long Fact' },
    })

    const fullRes = await recall(store, 'deliberately long body', {
      topK: 3,
      scoreThreshold: -1,
    })
    const fullHit = fullRes.hits.find((h) => h.path === 'long-fact.md')
    expect(fullHit).toBeDefined()
    expect(fullHit!.snippet.length).toBeGreaterThan(50)
    expect(fullHit!.snippet).toContain('deliberately long')

    const idxRes = await recall(store, 'deliberately long body', {
      topK: 3,
      scoreThreshold: -1,
      snippetMaxChars: 0,
    })
    const idxHit = idxRes.hits.find((h) => h.path === 'long-fact.md')
    expect(idxHit).toBeDefined()
    expect(idxHit!.snippet).toBe('Long Fact')
    expect(idxHit!.snippet).not.toContain('deliberately')
  })

  it('retrieve() snippetMaxChars caps body length without losing title metadata', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    await retain(store, {
      content:
        'Short fact about the Cortex module which handles reasoning, planning, and metacognition in the Tri-Brain.',
      metadata: { path: 'short-fact.md', title: 'Short Cortex Fact' },
    })

    const res = await recall(store, 'cortex module reasoning', {
      topK: 3,
      scoreThreshold: -1,
      snippetMaxChars: 40,
    })
    const hit = res.hits.find((h) => h.path === 'short-fact.md')
    expect(hit).toBeDefined()
    expect(hit!.snippet.length).toBeLessThanOrEqual(40)
    expect(hit!.title).toBe('Short Cortex Fact')
  })
})
