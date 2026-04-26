/**
 * Postgres graph backend (B.3a) — implements the GraphBackend interface
 * using two relational tables instead of a dedicated graph DB.
 *
 *   <table>_node(id, labels[], props jsonb, created_at)
 *   <table>_edge(id, from_node, to_node, rel, props, valid_from, valid_to,
 *                recorded_at, superseded_by)
 *
 * Bi-temporal asOf queries reduce to a containment check on a GiST-indexed
 * tstzrange(valid_from, COALESCE(valid_to, 'infinity'), '[)'), so they're
 * sub-millisecond at the scales GKS targets (≤ 10M edges).
 *
 * BFS traversal uses a Postgres recursive CTE — within an order of magnitude
 * of dedicated graph engines for shallow walks (depth ≤ 4) and avoids the
 * operational cost of a separate service.
 *
 * Same `pool` can be shared with PgvectorBackend; supersede flips happen in
 * a single transaction so vector + graph stay consistent.
 */

import type { Pool, PoolClient } from 'pg'
import { createHash, randomUUID } from 'node:crypto'

import { quoteIdent, safeLimit, withTx } from '../../lib/sql.js'

import type {
  AddEdgeArgs,
  AddNodeArgs,
  GraphBackend,
  GraphEdge,
  GraphNode,
  GraphQuery,
  NeighborQuery,
  NeighborResult,
} from '../graph.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('graph:pg')

export interface PgGraphBackendOptions {
  pool: Pool
  /** Physical table prefix. Default 'gks_graph' → tables gks_graph_node + gks_graph_edge. */
  table?: string
}

export function createPgGraphBackend(opts: PgGraphBackendOptions): GraphBackend {
  return new PgGraphBackend(opts)
}

class PgGraphBackend implements GraphBackend {
  private readonly pool: Pool
  private readonly nodeTable: string
  private readonly edgeTable: string
  private loaded = false

  constructor(opts: PgGraphBackendOptions) {
    const base = opts.table ?? 'gks_graph'
    quoteIdent(base, 'pg graph')
    this.pool = opts.pool
    this.nodeTable = `${base}_node`
    this.edgeTable = `${base}_edge`
  }

  async load(): Promise<void> {
    if (this.loaded) return
    // Probe both tables — surfaces missing-migration as a clear error.
    await this.pool.query(`SELECT 1 FROM ${quoteIdent(this.nodeTable)} LIMIT 0`)
    await this.pool.query(`SELECT 1 FROM ${quoteIdent(this.edgeTable)} LIMIT 0`)
    this.loaded = true
    log.info('pg graph backend loaded', { node_table: this.nodeTable, edge_table: this.edgeTable })
  }

  async addNode(args: AddNodeArgs): Promise<GraphNode> {
    await this.ensureLoaded()
    const id = args.id ?? stableId('N', args.labels.join(':'), JSON.stringify(args.props ?? {}))
    const props = args.props ?? {}

    // ON CONFLICT merge: union labels, shallow-merge props (matches the
    // in-memory GraphStore semantics).
    const result = await this.pool.query(
      `INSERT INTO ${quoteIdent(this.nodeTable)} (id, labels, props)
       VALUES ($1, $2::text[], $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         labels = (
           SELECT array_agg(DISTINCT lbl) FROM unnest(${quoteIdent(this.nodeTable)}.labels || EXCLUDED.labels) AS lbl
         ),
         props = ${quoteIdent(this.nodeTable)}.props || EXCLUDED.props
       RETURNING id, labels, props`,
      [id, args.labels, JSON.stringify(props)],
    )
    return rowToNode(result.rows[0] as PgNodeRow)
  }

  async addEdge(args: AddEdgeArgs): Promise<GraphEdge> {
    await this.ensureLoaded()
    const now = new Date().toISOString()
    const id = args.id ?? randomUUID()
    const validFrom = args.valid_from ?? now

    return withTx(this.pool, async (client) => {
      // Verify both endpoints exist (clear error instead of a deep FK
      // violation; preserves the in-memory backend's contract).
      await this.assertNodeExists(client, args.from, 'from')
      await this.assertNodeExists(client, args.to, 'to')

      if (args.supersede) {
        // Any currently-valid (from, rel) edge gets valid_to set to this
        // new edge's valid_from and superseded_by pointed at the new id.
        await client.query(
          `UPDATE ${quoteIdent(this.edgeTable)}
              SET valid_to = $3, superseded_by = $4
            WHERE from_node = $1 AND rel = $2 AND valid_to IS NULL AND id <> $4`,
          [args.from, args.rel, validFrom, id],
        )
      }

      const result = await client.query(
        `INSERT INTO ${quoteIdent(this.edgeTable)}
           (id, from_node, to_node, rel, props, valid_from, valid_to, recorded_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, NULL, $7)
         RETURNING id, from_node, to_node, rel, props, valid_from, valid_to, recorded_at, superseded_by`,
        [
          id,
          args.from,
          args.to,
          args.rel,
          JSON.stringify(args.props ?? {}),
          validFrom,
          now,
        ],
      )
      return rowToEdge(result.rows[0] as PgEdgeRow)
    })
  }

  async retractEdge(id: string, at: string = new Date().toISOString()): Promise<GraphEdge | null> {
    await this.ensureLoaded()
    const result = await this.pool.query(
      `UPDATE ${quoteIdent(this.edgeTable)}
          SET valid_to = $2
        WHERE id = $1 AND valid_to IS NULL
        RETURNING id, from_node, to_node, rel, props, valid_from, valid_to, recorded_at, superseded_by`,
      [id, at],
    )
    if (result.rows.length === 0) {
      // Maybe the edge exists but is already retracted — return its current row.
      const existing = await this.pool.query(
        `SELECT id, from_node, to_node, rel, props, valid_from, valid_to, recorded_at, superseded_by
           FROM ${quoteIdent(this.edgeTable)}
          WHERE id = $1`,
        [id],
      )
      if (existing.rows.length === 0) return null
      return rowToEdge(existing.rows[0] as PgEdgeRow)
    }
    return rowToEdge(result.rows[0] as PgEdgeRow)
  }

  async query(q: GraphQuery = {}): Promise<GraphEdge[]> {
    await this.ensureLoaded()
    const params: unknown[] = []
    const where: string[] = []

    if (q.from) {
      params.push(q.from)
      where.push(`from_node = $${params.length}`)
    }
    if (q.to) {
      params.push(q.to)
      where.push(`to_node = $${params.length}`)
    }
    if (q.rel) {
      params.push(q.rel)
      where.push(`rel = $${params.length}`)
    }
    if (!q.includeInvalid) {
      if (q.asOf) {
        params.push(q.asOf)
        where.push(
          `tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') @> $${params.length}::timestamptz`,
        )
      } else {
        where.push(`valid_to IS NULL`)
      }
    }

    const limitClause =
      q.limit !== undefined ? `LIMIT ${safeLimit(q.limit, { default: 100 })}` : ''
    const sql = `
      SELECT id, from_node, to_node, rel, props, valid_from, valid_to, recorded_at, superseded_by
        FROM ${quoteIdent(this.edgeTable)}
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY valid_from ASC
       ${limitClause}
    `
    const result = await this.pool.query(sql, params)
    return (result.rows as PgEdgeRow[]).map(rowToEdge)
  }

  async neighbors(seed: string, q: NeighborQuery = {}): Promise<NeighborResult[]> {
    await this.ensureLoaded()
    const depth = Math.max(1, q.depth ?? 1)
    const direction = q.direction ?? 'out'
    const limit = safeLimit(q.limit ?? 1000, { default: 1000 })

    // Validity predicate (parameterized).
    const params: unknown[] = [seed, depth]
    let validity = ''
    if (!q.includeInvalid) {
      if (q.asOf) {
        params.push(q.asOf)
        validity = `tstzrange(e.valid_from, COALESCE(e.valid_to, 'infinity'::timestamptz), '[)') @> $${params.length}::timestamptz`
      } else {
        validity = `e.valid_to IS NULL`
      }
    } else {
      validity = `TRUE`
    }
    if (q.rel) {
      params.push(q.rel)
      validity += ` AND e.rel = $${params.length}`
    }

    const traversal =
      direction === 'out'
        ? 't.next_id = e.from_node'
        : direction === 'in'
          ? 't.next_id = e.to_node'
          : '(t.next_id = e.from_node OR t.next_id = e.to_node)'

    const nextExpr =
      direction === 'out'
        ? 'e.to_node'
        : direction === 'in'
          ? 'e.from_node'
          : 'CASE WHEN e.from_node = t.next_id THEN e.to_node ELSE e.from_node END'

    // Recursive CTE: each step extends path with one edge. We stop at depth
    // by gating with hops < $2.
    const sql = `
      WITH RECURSIVE traversal AS (
        SELECT $1::text AS next_id,
               0 AS hops,
               ARRAY[]::text[] AS visited,
               ARRAY[]::text[] AS path_edges
        UNION ALL
        SELECT ${nextExpr} AS next_id,
               t.hops + 1 AS hops,
               t.visited || t.next_id AS visited,
               t.path_edges || e.id AS path_edges
          FROM traversal t
          JOIN ${quoteIdent(this.edgeTable)} e
            ON ${traversal}
         WHERE t.hops < $2
           AND ${validity}
           AND NOT (${nextExpr} = ANY(t.visited || t.next_id))
      )
      SELECT t.next_id, t.hops, t.path_edges
        FROM traversal t
       WHERE t.hops > 0
       ORDER BY t.hops ASC
       LIMIT ${limit}
    `

    const result = await this.pool.query(sql, params)
    if (result.rows.length === 0) return []

    // Resolve nodes + path edges in two batched lookups.
    const visitedIds = [...new Set((result.rows as Array<{ next_id: string }>).map((r) => r.next_id))]
    const pathEdgeIds = [
      ...new Set((result.rows as Array<{ path_edges: string[] }>).flatMap((r) => r.path_edges)),
    ]

    const [nodeMap, edgeMap] = await Promise.all([
      this.fetchNodes(visitedIds),
      this.fetchEdges(pathEdgeIds),
    ])

    const out: NeighborResult[] = []
    for (const row of result.rows as Array<{ next_id: string; hops: number; path_edges: string[] }>) {
      const node = nodeMap.get(row.next_id)
      if (!node) continue
      const path = row.path_edges
        .map((eid) => edgeMap.get(eid))
        .filter((e): e is GraphEdge => e !== undefined)
      out.push({ node, path, depth: row.hops })
    }
    return out
  }

  // ─── internal ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  private async assertNodeExists(client: PoolClient, id: string, role: 'from' | 'to'): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM ${quoteIdent(this.nodeTable)} WHERE id = $1`,
      [id],
    )
    if (result.rows.length === 0) {
      throw new Error(`addEdge: unknown ${role}-node ${id}`)
    }
  }

  private async fetchNodes(ids: string[]): Promise<Map<string, GraphNode>> {
    if (ids.length === 0) return new Map()
    const result = await this.pool.query(
      `SELECT id, labels, props FROM ${quoteIdent(this.nodeTable)} WHERE id = ANY($1::text[])`,
      [ids],
    )
    const map = new Map<string, GraphNode>()
    for (const row of result.rows as PgNodeRow[]) {
      map.set(row.id, rowToNode(row))
    }
    return map
  }

  private async fetchEdges(ids: string[]): Promise<Map<string, GraphEdge>> {
    if (ids.length === 0) return new Map()
    const result = await this.pool.query(
      `SELECT id, from_node, to_node, rel, props, valid_from, valid_to, recorded_at, superseded_by
         FROM ${quoteIdent(this.edgeTable)}
        WHERE id = ANY($1::text[])`,
      [ids],
    )
    const map = new Map<string, GraphEdge>()
    for (const row of result.rows as PgEdgeRow[]) {
      map.set(row.id, rowToEdge(row))
    }
    return map
  }
}

// ─── row mappers ───────────────────────────────────────────────────────────

interface PgNodeRow {
  id: string
  labels: string[]
  props: Record<string, unknown>
}

interface PgEdgeRow {
  id: string
  from_node: string
  to_node: string
  rel: string
  props: Record<string, unknown>
  valid_from: Date | string
  valid_to: Date | string | null
  recorded_at: Date | string
  superseded_by: string | null
}

function rowToNode(row: PgNodeRow): GraphNode {
  return {
    id: row.id,
    labels: row.labels ?? [],
    props: row.props ?? {},
  }
}

function rowToEdge(row: PgEdgeRow): GraphEdge {
  return {
    id: row.id,
    from: row.from_node,
    to: row.to_node,
    rel: row.rel,
    props: row.props ?? {},
    valid_from: toIso(row.valid_from),
    valid_to: row.valid_to == null ? null : toIso(row.valid_to),
    recorded_at: toIso(row.recorded_at),
    ...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
  }
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v
}

function stableId(prefix: string, ...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16)
  return `${prefix}-${h}`
}

