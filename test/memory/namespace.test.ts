/**
 * Multi-tenancy / namespace isolation tests.
 *
 * H.3.1 promotes Namespace to first-class. The contract:
 *   - retain() stamps the active namespace onto the doc's metadata.
 *   - retrieve() filters to the active namespace by default.
 *   - crossNamespace:true on retrieve() bypasses the filter.
 *   - retain() conflict-detection is also namespace-scoped — supersede on
 *     tenant A must not retire tenant B's facts.
 *   - The legacy `RetainInput.sessionId` still works (back-compat).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, mockEmbedder } from '../../src/memory/index.js'
import type { MemoryStoreOptions } from '../../src/memory/index.js'
import { recall, retain } from '../../src/memory/api.js'

async function withStore(defaultNamespace: MemoryStoreOptions['defaultNamespace'] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gks-ns-'))
  const store = new MemoryStore({
    root,
    embedder: mockEmbedder(64),
    reranker: { enabled: false },
    ...(defaultNamespace ? { defaultNamespace } : {}),
  })
  await store.init()
  return { store, root }
}

describe('namespace isolation', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('retain stamps the active namespace onto doc metadata', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    const r = await retain(store, {
      content: 'tenant-A-secret',
      namespace: { tenant_id: 'A', user_id: 'alice' },
    })
    const vs = await store.getVectorStore('atomic')
    const doc = (await vs.get(r.vectorDocId!))!
    expect(doc.metadata['tenant_id']).toBe('A')
    expect(doc.metadata['user_id']).toBe('alice')
  })

  it('recall filters to the active namespace', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    await retain(store, { content: 'tenant-A-fact', namespace: { tenant_id: 'A' } })
    await retain(store, { content: 'tenant-B-fact', namespace: { tenant_id: 'B' } })

    // Tenant A query — should see only A's docs.
    const aResult = await recall(store, 'fact', {
      strategy: 'vector',
      topK: 5,
      scoreThreshold: -1,
      namespace: { tenant_id: 'A' },
    })
    const aTexts = aResult.hits.map((h) => h.snippet)
    expect(aTexts).toEqual(['tenant-A-fact'])

    const bResult = await recall(store, 'fact', {
      strategy: 'vector',
      topK: 5,
      scoreThreshold: -1,
      namespace: { tenant_id: 'B' },
    })
    expect(bResult.hits.map((h) => h.snippet)).toEqual(['tenant-B-fact'])
  })

  it('crossNamespace:true bypasses the filter', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    await retain(store, { content: 'tenant-A-fact', namespace: { tenant_id: 'A' } })
    await retain(store, { content: 'tenant-B-fact', namespace: { tenant_id: 'B' } })

    const result = await recall(store, 'fact', {
      strategy: 'vector',
      topK: 5,
      scoreThreshold: -1,
      crossNamespace: true,
    })
    const texts = result.hits.map((h) => h.snippet).sort()
    expect(texts).toEqual(['tenant-A-fact', 'tenant-B-fact'])
  })

  it('falls back to defaultNamespace when retain/recall omit one', async () => {
    const { store, root } = await withStore({ tenant_id: 'A' })
    cleanup.push(root)

    await retain(store, { content: 'stamped-by-default' })
    const vs = await store.getVectorStore('atomic')
    const docs = vs.listDocs()
    expect(docs[0]!.metadata['tenant_id']).toBe('A')

    // recall without explicit namespace ALSO inherits defaultNamespace.
    const result = await recall(store, 'stamped', { strategy: 'vector', scoreThreshold: -1 })
    expect(result.hits).toHaveLength(1)
  })

  it('conflict resolution is scoped to the namespace', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    // Same content, different tenants. With supersede, tenant B's later
    // retain must NOT invalidate tenant A's earlier doc.
    const a = await retain(store, {
      content: 'shared content',
      namespace: { tenant_id: 'A' },
      conflictPolicy: 'supersede',
      conflictThreshold: 0,
    })
    const b = await retain(store, {
      content: 'shared content',
      namespace: { tenant_id: 'B' },
      conflictPolicy: 'supersede',
      conflictThreshold: 0,
    })

    const vs = await store.getVectorStore('atomic')
    const aDoc = (await vs.get(a.vectorDocId!))!
    const bDoc = (await vs.get(b.vectorDocId!))!
    // Tenant A's doc should still be valid (not retired by B's retain).
    expect(aDoc.metadata['valid_to']).toBeNull()
    expect(bDoc.metadata['valid_to']).toBeNull()
    // B's conflicts list should not name A's doc.
    expect(b.conflicts.every((c) => c.existingId !== a.vectorDocId)).toBe(true)
  })

  it('supports legacy RetainInput.sessionId (maps to namespace.session_id)', async () => {
    const { store, root } = await withStore()
    cleanup.push(root)

    const r = await retain(store, {
      content: 'legacy session retain',
      sessionId: 'sess-001',
    })
    const vs = await store.getVectorStore('atomic')
    const doc = (await vs.get(r.vectorDocId!))!
    expect(doc.metadata['session_id']).toBe('sess-001')

    // recall with the same session_id should find it.
    const result = await recall(store, 'legacy', {
      strategy: 'vector',
      scoreThreshold: -1,
      namespace: { session_id: 'sess-001' },
    })
    expect(result.hits).toHaveLength(1)
  })

  it('a retain with explicit namespace overrides defaultNamespace', async () => {
    const { store, root } = await withStore({ tenant_id: 'default-tenant' })
    cleanup.push(root)

    const r = await retain(store, {
      content: 'override-test',
      namespace: { tenant_id: 'explicit-tenant' },
    })
    const vs = await store.getVectorStore('atomic')
    const doc = (await vs.get(r.vectorDocId!))!
    expect(doc.metadata['tenant_id']).toBe('explicit-tenant')
  })
})
