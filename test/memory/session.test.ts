import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, cp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MemoryStore, startSession, endSession } from '../../src/memory/index.js'
import { createMockObsidianAdapter, type MockVault } from '../../src/memory/obsidian-mcp.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

async function withStore(extra: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gks-sess-'))
  await mkdir(join(root, 'gks'), { recursive: true })
  await cp(FIXTURES, join(root, 'gks'), { recursive: true })
  const store = new MemoryStore({
    root,
    embedder: mockEmbedder(32),
    reranker: { enabled: false },
    ...extra,
  })
  await store.init()
  return { store, root }
}

describe('startSession', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('reports atomic count + embedder info + writes session.json', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    const report = await startSession(store, { participants: ['user', 'agent'] })
    expect(report.atomicLoaded).toBe(3) // fixture has 3 atoms
    expect(report.embedder.provider).toBe('mock')
    expect(report.vectorManifestCompatible).toBe(true)
    expect(report.warnings).toEqual([])

    const json = JSON.parse(await readFile(report.sessionFilePath, 'utf8')) as {
      id: string
      status: string
    }
    expect(json.status).toBe('active')
    expect(json.id).toBe(report.session.id)
  })

  it('auto-generates session IDs in the MSP-SESS-YYMMDD<serial> format', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)
    const report = await startSession(store)
    expect(report.session.id).toMatch(/^MSP-SESS-\d{6}[A-F0-9]{4}$/)
  })

  it('accepts an explicit session id', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)
    const report = await startSession(store, { id: 'MSP-SESS-EXPLICIT-001' })
    expect(report.session.id).toBe('MSP-SESS-EXPLICIT-001')
  })

  it('marks obsidian reachable when adapter pings ok', async () => {
    const vault: MockVault = { notes: [] }
    const obsidian = createMockObsidianAdapter(vault)
    const { store, root } = await withStore({ obsidian })
    cleanup.push(root)
    const report = await startSession(store)
    expect(report.obsidianReachable).toBe(true)
  })

  it('reports obsidian unreachable and warns when adapter ping times out', async () => {
    const slow = {
      id: 'slow',
      async ping() {
        return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000))
      },
      async search() { return [] },
      async resolveWikilink() { return null },
      async backlinksOf() { return [] },
      async tagQuery() { return [] },
    }
    const { store, root } = await withStore({ obsidian: slow })
    cleanup.push(root)
    const report = await startSession(store, { obsidianPingTimeoutMs: 50 })
    expect(report.obsidianReachable).toBe(false)
    expect(report.warnings.some((w) => w.includes('obsidian'))).toBe(true)
  })
})

describe('endSession', () => {
  let cleanup: string[] = []
  beforeEach(() => { cleanup = [] })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('reads the trace, updates session.json, and can skip consolidation when trigger not met', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    const start = await startSession(store, { participants: ['u', 'a'] })

    // Short trace → below consolidation threshold
    for (let i = 0; i < 3; i++) {
      await store.appendTrace(start.session.id, { kind: 'user', content: `turn ${i}` })
      await store.appendTrace(start.session.id, { kind: 'agent', content: `reply ${i}` })
    }

    const end = await endSession(store, start.session)
    expect(end.traceSteps).toBe(6)
    expect(end.triggered).toBe(false)
    expect(end.consolidated).toBe(false)

    const json = JSON.parse(await readFile(end.sessionFilePath, 'utf8')) as {
      status: string
      consolidated: boolean
      ended_at: string
    }
    expect(json.status).toBe('ended')
    expect(json.consolidated).toBe(false)
    expect(json.ended_at).toBeTypeOf('string')
  })

  it('forces consolidation when forceConsolidate=true', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)
    const start = await startSession(store)

    for (let i = 0; i < 2; i++) {
      await store.appendTrace(start.session.id, { kind: 'user', content: `q${i}` })
      await store.appendTrace(start.session.id, { kind: 'agent', content: `a${i}` })
    }

    const end = await endSession(store, start.session, { forceConsolidate: true })
    expect(end.consolidated).toBe(true)
    expect(end.reflect).toBeDefined()
    expect(end.reflect!.memory.session_id).toBe(start.session.id)
  })
})
