/**
 * HnswBackend integration tests — uses real hnswlib-node native binding
 * against a tempdir (no Postgres needed).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHnswBackend, mockEmbedder } from '../../src/memory/index.js'

const hnswlibAvailable = await import('hnswlib-node')
  .then(() => true)
  .catch(() => false)

describe.skipIf(!hnswlibAvailable)('HnswBackend', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gks-hnsw-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function newBackend(dim = 32) {
    return createHnswBackend({
      basePath: join(dir, 'atomic'),
      embedder: mockEmbedder(dim),
      name: 'atomic',
      initialMaxElements: 64,
    })
  }

  it('add → search returns the matching doc with high cosine score', async () => {
    const b = await newBackend()
    await b.add('the cat sat on the mat', { path: 'a.md' })
    await b.add('completely unrelated quantum mechanics', { path: 'b.md' })
    const hits = await b.search('the cat sat on the mat', { topK: 1, scoreThreshold: 0.5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.doc.text).toBe('the cat sat on the mat')
    expect(hits[0]!.score).toBeGreaterThan(0.9)
  })

  it('addBatch ingests N items in one call', async () => {
    const b = await newBackend()
    await b.addBatch([
      { text: 'alpha', metadata: { path: 'a.md' } },
      { text: 'beta', metadata: { path: 'b.md' } },
      { text: 'gamma', metadata: { path: 'g.md' } },
    ])
    expect(b.size()).toBe(3)
    const hits = await b.search('beta', { topK: 1, scoreThreshold: -1 })
    expect(hits[0]!.doc.text).toBe('beta')
  })

  it('persists across reload (vectors restored from .hnsw)', async () => {
    const b1 = await newBackend()
    await b1.add('persistent doc', { path: 'p.md', tags: ['x'] })
    await b1.add('another persistent doc', { path: 'q.md' })

    const b2 = await newBackend()
    expect(b2.size()).toBe(2)
    const hits = await b2.search('persistent doc', { topK: 2, scoreThreshold: -1 })
    // Both saved docs should be searchable after reload.
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.doc.text === 'persistent doc')).toBe(true)
  })

  it('grows past initialMaxElements without losing data', async () => {
    const b = await createHnswBackend({
      basePath: join(dir, 'small'),
      embedder: mockEmbedder(16),
      name: 'atomic',
      initialMaxElements: 4,
    })
    for (let i = 0; i < 12; i++) {
      await b.add(`doc ${i}`, { path: `${i}.md` })
    }
    expect(b.size()).toBe(12)
    const hits = await b.search('doc 7', { topK: 3, scoreThreshold: -1 })
    expect(hits[0]!.doc.text).toBe('doc 7')
  })

  it('patchMetadataMany updates metadata without disturbing vectors', async () => {
    const b = await newBackend()
    const a = await b.add('doc-a', { path: 'a.md' })
    const result = await b.patchMetadataMany([
      { id: a.id, patch: { valid_to: '2026-04-25T00:00:00Z' } },
    ])
    expect(result[0]!.metadata['valid_to']).toBe('2026-04-25T00:00:00Z')

    // Search still finds it (vector untouched).
    const hits = await b.search('doc-a', { topK: 1, scoreThreshold: -1 })
    expect(hits[0]!.doc.metadata['valid_to']).toBe('2026-04-25T00:00:00Z')
  })

  it('clear() empties the index and metadata', async () => {
    const b = await newBackend()
    await b.add('x', { path: 'x.md' })
    expect(b.size()).toBe(1)
    await b.clear()
    expect(b.size()).toBe(0)
    const hits = await b.search('x', { topK: 1, scoreThreshold: -1 })
    expect(hits).toEqual([])
  })

  it('rejects vectors with mismatched dimension', async () => {
    const b = await newBackend(8)
    await expect(b.addWithVector('x', [1, 2, 3], { path: 'a.md' })).rejects.toThrow(
      /vector dim 3 but embedder declared 8/,
    )
  })

  it('manifest reports embedder + doc count', async () => {
    const b = await newBackend(8)
    await b.add('one', { path: '1.md' })
    await b.add('two', { path: '2.md' })
    const m = b.getManifest()
    expect(m.doc_count).toBe(2)
    expect(m.dimension).toBe(8)
    expect(m.embedder_model).toMatch(/^mock-sha256/)
  })

  it('listDocs returns all stored docs', async () => {
    const b = await newBackend()
    await b.add('a', { path: 'a.md' })
    await b.add('b', { path: 'b.md' })
    const docs = b.listDocs()
    expect(docs).toHaveLength(2)
    expect(docs.map((d) => d.text).sort()).toEqual(['a', 'b'])
  })

  it('discards an incompatible on-disk index when embedder changes', async () => {
    const b1 = await createHnswBackend({
      basePath: join(dir, 'shifty'),
      embedder: mockEmbedder(16),
      name: 'atomic',
    })
    await b1.add('doc', { path: 'd.md' })

    // Reopen with a different embedder dim — should detect the mismatch and
    // start fresh rather than crash with a dim error from hnswlib.
    const b2 = await createHnswBackend({
      basePath: join(dir, 'shifty'),
      embedder: mockEmbedder(32),
      name: 'atomic',
    })
    expect(b2.size()).toBe(0)
  })
})
