/**
 * PgGraphBackend unit tests with a mock pg.Pool. Real Postgres integration is
 * verified via docker-compose (out of scope for unit tests).
 */

import { describe, it, expect } from 'vitest'

import { createPgGraphBackend } from '../../src/memory/index.js'
import { makeMockPool } from '../fixtures/mock-pg-pool.js'

describe('PgGraphBackend', () => {
  it('load() probes both node and edge tables', async () => {
    const { pool, queries } = makeMockPool()
    const g = createPgGraphBackend({ pool })
    await g.load()
    expect(queries[0]!.text).toMatch(/FROM "gks_graph_node" LIMIT 0/)
    expect(queries[1]!.text).toMatch(/FROM "gks_graph_edge" LIMIT 0/)
  })

  it('addNode upserts with array_agg labels and jsonb prop merge', async () => {
    const { pool, queries } = makeMockPool({
      'INSERT INTO "gks_graph_node"': [
        { id: 'u1', labels: ['User'], props: { name: 'Alice' } },
      ],
    })
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    const node = await g.addNode({ id: 'u1', labels: ['User'], props: { name: 'Alice' } })
    expect(node.id).toBe('u1')

    const insert = queries.find((q) => q.text.includes('INSERT INTO "gks_graph_node"'))!
    expect(insert.text).toMatch(/ON CONFLICT \(id\) DO UPDATE/)
    expect(insert.text).toMatch(/array_agg\(DISTINCT lbl\)/)
    expect(insert.text).toMatch(/props \|\| EXCLUDED\.props/)
    expect(insert.params?.[1]).toEqual(['User'])
  })

  it('addEdge supersede=true wraps the supersede UPDATE in a transaction', async () => {
    const { pool, queries } = makeMockPool({
      'SELECT 1 FROM "gks_graph_node"': [{ exists: 1 }],
      'INSERT INTO "gks_graph_edge"': [
        {
          id: 'edge-1',
          from_node: 'u1',
          to_node: 'paris',
          rel: 'LIVES_IN',
          props: {},
          valid_from: new Date('2024-06-01T00:00:00Z'),
          valid_to: null,
          recorded_at: new Date('2024-06-01T00:00:00Z'),
          superseded_by: null,
        },
      ],
    })
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    await g.addEdge({
      from: 'u1',
      to: 'paris',
      rel: 'LIVES_IN',
      valid_from: '2024-06-01T00:00:00Z',
      supersede: true,
    })

    expect(queries[0]!.text).toBe('BEGIN')
    expect(queries.at(-1)!.text).toBe('COMMIT')

    const supersedeUpdate = queries.find((q) =>
      q.text.includes('UPDATE "gks_graph_edge"') && q.text.includes('valid_to = $3'),
    )
    expect(supersedeUpdate).toBeDefined()
    expect(supersedeUpdate!.text).toMatch(/from_node = \$1 AND rel = \$2 AND valid_to IS NULL/)
  })

  it('addEdge rejects unknown endpoint nodes', async () => {
    const { pool } = makeMockPool({
      // SELECT 1 returns empty → from-node missing
      'SELECT 1 FROM "gks_graph_node"': [],
    })
    const g = createPgGraphBackend({ pool })
    await g.load()

    await expect(
      g.addEdge({ from: 'ghost', to: 'paris', rel: 'LIVES_IN' }),
    ).rejects.toThrow(/unknown from-node ghost/)
  })

  it('query() with asOf produces a tstzrange containment predicate', async () => {
    const { pool, queries } = makeMockPool()
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    await g.query({ from: 'u1', rel: 'LIVES_IN', asOf: '2023-06-01T00:00:00Z' })

    const select = queries.find((q) => q.text.includes('FROM "gks_graph_edge"'))!
    expect(select.text).toMatch(/tstzrange\(valid_from, COALESCE\(valid_to, 'infinity'/)
    expect(select.text).toMatch(/@>/)
    expect(select.params).toEqual(['u1', 'LIVES_IN', '2023-06-01T00:00:00Z'])
  })

  it('query() default hides retracted edges', async () => {
    const { pool, queries } = makeMockPool()
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    await g.query({ from: 'u1' })
    const select = queries.find((q) => q.text.includes('FROM "gks_graph_edge"'))!
    expect(select.text).toMatch(/valid_to IS NULL/)
  })

  it('query({includeInvalid:true}) drops the validity filter', async () => {
    const { pool, queries } = makeMockPool()
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    await g.query({ from: 'u1', includeInvalid: true })
    const select = queries.find((q) => q.text.includes('FROM "gks_graph_edge"'))!
    expect(select.text).not.toMatch(/valid_to IS NULL/)
    expect(select.text).not.toMatch(/tstzrange/)
  })

  it('retractEdge updates valid_to where currently null', async () => {
    const { pool, queries } = makeMockPool({
      'UPDATE "gks_graph_edge"': [
        {
          id: 'e1',
          from_node: 'a',
          to_node: 'b',
          rel: 'R',
          props: {},
          valid_from: new Date(),
          valid_to: new Date('2025-06-01T00:00:00Z'),
          recorded_at: new Date(),
          superseded_by: null,
        },
      ],
    })
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    const out = await g.retractEdge('e1', '2025-06-01T00:00:00Z')
    // Driver returns a Date object; rowToEdge normalises to ISO string.
    expect(out?.valid_to).toBe('2025-06-01T00:00:00.000Z')
    const update = queries.find((q) => q.text.includes('UPDATE "gks_graph_edge"'))!
    expect(update.text).toMatch(/SET valid_to = \$2/)
    expect(update.text).toMatch(/WHERE id = \$1 AND valid_to IS NULL/)
  })

  it('neighbors() builds a recursive CTE bounded by depth', async () => {
    const { pool, queries } = makeMockPool({
      'WITH RECURSIVE traversal': [
        { next_id: 'b', hops: 1, path_edges: ['e-a-b'] },
      ],
      'FROM "gks_graph_node" WHERE id = ANY': [
        { id: 'b', labels: ['City'], props: {} },
      ],
      'FROM "gks_graph_edge"\n        WHERE id = ANY': [
        {
          id: 'e-a-b',
          from_node: 'a',
          to_node: 'b',
          rel: 'KNOWS',
          props: {},
          valid_from: new Date(),
          valid_to: null,
          recorded_at: new Date(),
          superseded_by: null,
        },
      ],
    })
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    const out = await g.neighbors('a', { depth: 2 })
    expect(out).toHaveLength(1)
    expect(out[0]!.node.id).toBe('b')
    expect(out[0]!.depth).toBe(1)
    expect(out[0]!.path[0]!.id).toBe('e-a-b')

    const cte = queries.find((q) => q.text.includes('WITH RECURSIVE traversal'))!
    expect(cte.text).toMatch(/t\.hops < \$2/)
    expect(cte.text).toMatch(/NOT \(.+ANY\(t\.visited \|\| t\.next_id\)\)/)
    expect(cte.params?.[0]).toBe('a')
    expect(cte.params?.[1]).toBe(2)
  })

  it('neighbors({direction:"in"}) traverses incoming edges', async () => {
    const { pool, queries } = makeMockPool()
    const g = createPgGraphBackend({ pool })
    await g.load()
    queries.length = 0

    await g.neighbors('d', { depth: 3, direction: 'in' })
    const cte = queries.find((q) => q.text.includes('WITH RECURSIVE traversal'))!
    expect(cte.text).toMatch(/t\.next_id = e\.to_node/)
  })

  it('rejects malicious table names at construction', () => {
    const { pool } = makeMockPool()
    expect(() =>
      createPgGraphBackend({ pool, table: 'evil"; DROP TABLE x; --' }),
    ).toThrow(/invalid identifier/)
  })
})
