/**
 * AuditLog tests + integration: every retain / recall / proposeInbound /
 * lookup / writeEpisodic emits one audit event stamped with the active
 * namespace. Verified on disk + via the onEvent hook.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuditLog, MemoryStore, mockEmbedder } from '../../src/memory/index.js'
import type { AuditEvent } from '../../src/memory/index.js'
import { recall, retain } from '../../src/memory/api.js'

describe('AuditLog (unit)', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gks-audit-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes one JSONL line per emit, day-rotated filename', async () => {
    const log = new AuditLog({ dir })
    const t = '2026-04-25T10:00:00.000Z'
    await log.emit({ t, op: 'retain', doc_id: 'd1', namespace: { tenant_id: 'A' } })
    await log.emit({ t, op: 'recall', query: 'hello', hit_count: 3 })

    const files = await readdir(dir)
    expect(files).toContain('audit-2026-04-25.jsonl')
    const lines = (await readFile(join(dir, 'audit-2026-04-25.jsonl'), 'utf8'))
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2)
    const e1 = JSON.parse(lines[0]!) as AuditEvent
    expect(e1.op).toBe('retain')
    expect(e1.doc_id).toBe('d1')
    expect(e1.namespace?.tenant_id).toBe('A')
  })

  it('truncates the query field (default 200 chars)', async () => {
    const log = new AuditLog({ dir })
    const longQuery = 'x'.repeat(500)
    await log.emit({ op: 'recall', query: longQuery })
    const files = await readdir(dir)
    const lines = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n')
    const e = JSON.parse(lines[0]!) as AuditEvent
    expect(e.query!.length).toBeLessThanOrEqual(200)
    expect(e.query!.endsWith('…')).toBe(true)
  })

  it('calls the onEvent hook after the disk write', async () => {
    const events: AuditEvent[] = []
    const log = new AuditLog({
      dir,
      onEvent: (e) => {
        events.push(e)
      },
    })
    await log.emit({ op: 'retain', doc_id: 'd1' })
    await log.emit({ op: 'recall', query: 'q' })
    expect(events).toHaveLength(2)
    expect(events[0]!.op).toBe('retain')
  })

  it('disableDisk skips writes, still calls hook', async () => {
    const events: AuditEvent[] = []
    const log = new AuditLog({
      dir,
      disableDisk: true,
      onEvent: (e) => {
        events.push(e)
      },
    })
    await log.emit({ op: 'retain', doc_id: 'd1' })
    expect(events).toHaveLength(1)
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      /* directory may not exist — fine */
    }
    expect(files.filter((f) => f.startsWith('audit-'))).toHaveLength(0)
  })

  it('logs but does not throw when the disk write fails', async () => {
    // Point at a path that requires creating a child of an existing regular
    // file (mkdir will fail with ENOTDIR).
    const fileAsParent = join(dir, 'not-a-dir')
    await (await import('node:fs/promises')).writeFile(fileAsParent, '')
    const log = new AuditLog({ dir: join(fileAsParent, 'wont-create') })
    await log.emit({ op: 'retain', doc_id: 'd1' })
  })
})

describe('AuditLog integration with MemoryStore', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gks-audit-int-'))
    cleanup.push(root)
    const events: AuditEvent[] = []
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
      defaultNamespace: { tenant_id: 'A' },
      audit: {
        onEvent: (e) => {
          events.push(e)
        },
      },
    })
    await store.init()
    return { store, events }
  }

  it('retain emits an event with namespace + doc_id + conflicts', async () => {
    const { store, events } = await setup()
    await retain(store, { content: 'fact one', metadata: { path: 'a.md' } })

    const retainEvents = events.filter((e) => e.op === 'retain')
    expect(retainEvents).toHaveLength(1)
    const e = retainEvents[0]!
    expect(e.doc_id).toBeTypeOf('string')
    expect(e.namespace?.tenant_id).toBe('A')
    expect(e.conflicts).toBe(0)
    expect(e.invalidated).toBe(0)
  })

  it('recall emits an event with query + hit_count + strategy', async () => {
    const { store, events } = await setup()
    await retain(store, { content: 'searchable text' })
    await recall(store, 'searchable', { strategy: 'vector', topK: 3, scoreThreshold: -1 })

    const recallEvents = events.filter((e) => e.op === 'recall')
    expect(recallEvents).toHaveLength(1)
    expect(recallEvents[0]!.query).toBe('searchable')
    expect(recallEvents[0]!.strategy).toBe('vector')
    expect(typeof recallEvents[0]!.hit_count).toBe('number')
    expect(recallEvents[0]!.namespace?.tenant_id).toBe('A')
  })

  it('crossNamespace recall stamps meta.cross_namespace and drops the namespace', async () => {
    const { store, events } = await setup()
    await retain(store, { content: 'whatever' })
    await recall(store, 'whatever', {
      strategy: 'vector',
      crossNamespace: true,
      scoreThreshold: -1,
    })

    const recallEvent = events.filter((e) => e.op === 'recall').at(-1)!
    expect(recallEvent.namespace).toBeUndefined()
    expect((recallEvent.meta as { cross_namespace?: boolean }).cross_namespace).toBe(true)
  })

  it('proposeInbound emits with review_id + proposed_id', async () => {
    const { store, events } = await setup()
    await store.proposeInbound({
      proposed_id: 'INSIGHT--TEST',
      phase: 1,
      type: 'insight',
      title: 'Test',
      body: 'Body.',
    })
    const e = events.find((ev) => ev.op === 'propose_inbound')!
    expect(e.doc_id).toBe('INSIGHT--TEST')
    expect(e.review_id).toMatch(/^rev-/)
  })

  it('audit:false disables the log entirely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-noaudit-'))
    cleanup.push(root)
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
      audit: false,
    })
    await store.init()
    expect(store.audit).toBeNull()
    // No throw, just a silent no-op.
    await retain(store, { content: 'x' })
    await recall(store, 'x', { strategy: 'vector', scoreThreshold: -1 })
  })
})
