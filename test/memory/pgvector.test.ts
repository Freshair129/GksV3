/**
 * PgvectorBackend unit tests — verify SQL shape + interface conformance with
 * a mock pg client. Real-Postgres integration is exercised separately via
 * docker-compose (see docker-compose.pg.yml + scripts/msp/pg-migrate.ts).
 */

import { describe, it, expect } from 'vitest'

import {
  createPgvectorBackend,
  vectorToPg,
  pgToVector,
  mockEmbedder,
} from '../../src/memory/index.js'
import { makeMockPool } from '../fixtures/mock-pg-pool.js'

describe('vectorToPg / pgToVector', () => {
  it('round-trips an array', () => {
    const v = [0.1, -0.2, 1.5]
    expect(pgToVector(vectorToPg(v))).toEqual(v)
  })
  it('handles the empty case', () => {
    expect(pgToVector('[]')).toEqual([])
  })
  it('passes through arrays from drivers that already parse', () => {
    expect(pgToVector([1, 2, 3])).toEqual([1, 2, 3])
  })
})

describe('PgvectorBackend', () => {
  it('load() probes the table and fetches the manifest', async () => {
    const { pool, queries } = makeMockPool({
      // First call after CREATE check is the manifest fetch.
      'FROM "gks_vector_manifest"': [
        {
          embedder_model: 'mock-sha256-d32',
          dimension: 32,
          doc_count: 0,
          last_updated: new Date('2026-04-25T00:00:00Z'),
          file_hashes: {},
        },
      ],
    })
    const backend = createPgvectorBackend({
      pool,
      embedder: mockEmbedder(32),
      name: 'atomic',
    })

    await backend.load()
    expect(queries[0]!.text).toMatch(/SELECT 1 FROM "gks_vector"/)
    expect(queries[1]!.text).toMatch(/FROM "gks_vector_manifest"/)
    expect(backend.getManifest().doc_count).toBe(0)
  })

  it('addWithVector issues an upsert with the vector + jsonb metadata', async () => {
    const { pool, queries } = makeMockPool()
    const backend = createPgvectorBackend({
      pool,
      embedder: mockEmbedder(8),
      name: 'atomic',
    })
    await backend.load()
    queries.length = 0

    const doc = await backend.addWithVector(
      'hello',
      [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      { path: 'h.md', tags: ['greeting'] },
    )

    const insert = queries.find((q) => q.text.includes('INSERT INTO "gks_vector"'))!
    expect(insert).toBeDefined()
    expect(insert.text).toMatch(/ON CONFLICT \(id\) DO UPDATE/)
    expect(insert.params?.[0]).toBe(doc.id)
    expect(insert.params?.[1]).toBe('atomic')
    expect(insert.params?.[5]).toBe('[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8]')
    expect(JSON.parse(insert.params?.[6] as string)).toMatchObject({ path: 'h.md' })

    // bumpManifest call follows.
    expect(queries.some((q) => q.text.includes('INSERT INTO "gks_vector_manifest"'))).toBe(true)
  })

  it('rejects vectors with the wrong dimension', async () => {
    const { pool } = makeMockPool()
    const backend = createPgvectorBackend({
      pool,
      embedder: mockEmbedder(4),
      name: 'atomic',
    })
    await backend.load()
    await expect(
      backend.addWithVector('x', [1, 2, 3], { path: 'a.md' }),
    ).rejects.toThrow(/vector dim 3 but embedder declared 4/)
  })

  it('search() builds the cosine-distance ORDER BY and applies LIMIT', async () => {
    const { pool, queries } = makeMockPool({
      'ORDER BY vector': [
        {
          id: 'doc-1',
          source: 'a.md',
          chunk_id: 'c1',
          text: 'hello world',
          vector: [0.1, 0.2],
          metadata: { path: 'a.md' },
          created_at: new Date(),
          score: 0.95,
        },
      ],
    })
    const backend = createPgvectorBackend({
      pool,
      embedder: mockEmbedder(2),
      name: 'atomic',
    })
    await backend.load()
    queries.length = 0

    const hits = await backend.search([0.5, 0.5], { topK: 3, scoreThreshold: 0.5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.score).toBe(0.95)
    expect(hits[0]!.doc.text).toBe('hello world')

    // Verify HNSW ef_search SET LOCAL hit + ORDER BY shape.
    expect(queries.some((q) => q.text.match(/SET LOCAL hnsw\.ef_search = 40/))).toBe(true)
    const select = queries.find((q) => q.text.includes('ORDER BY vector'))!
    expect(select.text).toMatch(/<=>/)
    expect(select.text).toMatch(/LIMIT 3/)
    expect(select.params?.[0]).toBe('[0.5,0.5]')
    expect(select.params?.[1]).toBe('atomic')
  })

  it('patchMetadataMany batches updates inside one transaction', async () => {
    const { pool, queries } = makeMockPool({
      'UPDATE "gks_vector"': [
        {
          id: 'p1',
          source: 'a.md',
          chunk_id: 'c1',
          text: 'old',
          vector: [0.1],
          metadata: { valid_to: '2026-04-25T00:00:00Z' },
          created_at: new Date(),
        },
      ],
    })
    const backend = createPgvectorBackend({
      pool,
      embedder: mockEmbedder(1),
      name: 'atomic',
    })
    await backend.load()
    queries.length = 0

    const out = await backend.patchMetadataMany([
      { id: 'p1', patch: { valid_to: '2026-04-25T00:00:00Z' } },
      { id: 'p2', patch: { valid_to: '2026-04-25T00:00:00Z' } },
    ])

    expect(out).toHaveLength(2)
    expect(queries[0]!.text).toBe('BEGIN')
    expect(queries.at(-1)!.text).toBe('COMMIT')

    const updates = queries.filter((q) => q.text.includes('UPDATE "gks_vector"'))
    expect(updates).toHaveLength(2)
    expect(updates[0]!.text).toMatch(/metadata = metadata \|\| \$2::jsonb/)
  })

  it('clear() deletes by store and zeroes the manifest row', async () => {
    const { pool, queries } = makeMockPool()
    const backend = createPgvectorBackend({
      pool,
      embedder: mockEmbedder(2),
      name: 'atomic',
    })
    await backend.load()
    queries.length = 0

    await backend.clear()
    expect(queries[0]!.text).toMatch(/DELETE FROM "gks_vector"/)
    expect(queries[0]!.params).toEqual(['atomic'])
    expect(queries[1]!.text).toMatch(/INSERT INTO "gks_vector_manifest"/)
  })

  it('rejects malicious table names at construction', () => {
    const { pool } = makeMockPool()
    expect(() =>
      createPgvectorBackend({
        pool,
        embedder: mockEmbedder(2),
        name: 'atomic',
        table: 'evil"; DROP TABLE x; --',
      }),
    ).toThrow(/invalid identifier/)
  })

  it('listDocs() throws — DB-backed must use listAllDocs()', async () => {
    const { pool } = makeMockPool()
    const backend = createPgvectorBackend({
      pool,
      embedder: mockEmbedder(2),
      name: 'atomic',
    })
    await backend.load()
    expect(() => backend.listDocs()).toThrow(/listDocs|listAllDocs/)
  })
})
