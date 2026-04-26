/**
 * Temporal Knowledge Graph — in-process implementation.
 *
 * Spec reference (user Spec §2.3): "Temporal Knowledge Graph — การเก็บความจริง
 * ที่เปลี่ยนแปลงตามเวลา" (facts that change over time). The production target
 * is FalkorDB / Neo4j; this module gives us the same API shape with a plain
 * in-memory adjacency store + JSONL persistence, so:
 *
 *   (a) We can ship the graph-backed retrieval path today without waiting for
 *       infra to be provisioned, and
 *   (b) When a real graph DB is wired up (Phase 2B), we drop in a new
 *       GraphBackend and leave the callers untouched.
 *
 * Data model — bi-temporal (valid_from / valid_to) on every edge, plus an
 * ingestion timestamp so audits can distinguish "when did we learn this?" from
 * "when was it true in the world?".
 *
 *   Node:  { id, labels[], props }
 *   Edge:  { id, from, to, rel, props, valid_from, valid_to, recorded_at,
 *            superseded_by? }
 *
 * Persistence — append-only JSONL (node + edge events). Reads rebuild the
 * current-state adjacency maps on open. `retract(edge_id)` writes a retract
 * event rather than mutating history.
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendJsonl, forEachJsonl } from '../lib/jsonl.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('graph')

export interface GraphNode {
  id: string
  labels: string[]
  props: Record<string, unknown>
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  rel: string
  props: Record<string, unknown>
  valid_from: string
  /** null ⇒ still valid; a timestamp ⇒ was invalidated at that point. */
  valid_to: string | null
  recorded_at: string
  superseded_by?: string
}

export interface AddNodeArgs {
  id?: string
  labels: string[]
  props?: Record<string, unknown>
}

export interface AddEdgeArgs {
  id?: string
  from: string
  to: string
  rel: string
  props?: Record<string, unknown>
  valid_from?: string
  /** If true (default false), supersede all currently-valid edges matching
   *  ({from, to, rel}) — invalidates them and points them at this new edge. */
  supersede?: boolean
}

export interface GraphQuery {
  from?: string
  to?: string
  rel?: string
  /** ISO timestamp — only return edges valid at or before this point. */
  asOf?: string
  /** If true, include retracted edges. Default false. */
  includeInvalid?: boolean
  limit?: number
}

export interface NeighborQuery {
  depth?: number           // default 1
  rel?: string             // filter by relation
  direction?: 'out' | 'in' | 'both' // default 'out'
  asOf?: string
  includeInvalid?: boolean
  limit?: number
}

export interface NeighborResult {
  node: GraphNode
  path: GraphEdge[]  // edge sequence from the seed to this node
  depth: number
}

interface Event {
  kind: 'node' | 'edge' | 'edge_retract'
  payload: unknown
}

export interface GraphStoreOptions {
  /** JSONL file path. If omitted, runs purely in-memory (no persistence). */
  path?: string
}

export class GraphStore {
  private readonly path: string | null
  private readonly nodes = new Map<string, GraphNode>()
  private readonly edges = new Map<string, GraphEdge>()
  private readonly outIdx = new Map<string, Set<string>>() // from → edgeIds
  private readonly inIdx = new Map<string, Set<string>>()  // to   → edgeIds
  private loaded = false

  constructor(opts: GraphStoreOptions = {}) {
    this.path = opts.path ?? null
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.path) {
      try {
        await forEachJsonl<Event>(this.path, (evt) => this.apply(evt))
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') throw err
      }
    }
    this.loaded = true
    log.info('graph loaded', { nodes: this.nodes.size, edges: this.edges.size })
  }

  size(): { nodes: number; edges: number } {
    return { nodes: this.nodes.size, edges: this.edges.size }
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id)
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id)
  }

  async addNode(args: AddNodeArgs): Promise<GraphNode> {
    if (!this.loaded) await this.load()
    const id = args.id ?? stableId('N', args.labels.join(':'), JSON.stringify(args.props ?? {}))
    const existing = this.nodes.get(id)
    if (existing) {
      // Merge props on conflict — graph nodes are mostly append-only by convention.
      const merged: GraphNode = {
        id,
        labels: [...new Set([...existing.labels, ...args.labels])],
        props: { ...existing.props, ...(args.props ?? {}) },
      }
      this.nodes.set(id, merged)
      await this.persist({ kind: 'node', payload: merged })
      return merged
    }
    const node: GraphNode = { id, labels: args.labels, props: args.props ?? {} }
    this.nodes.set(id, node)
    await this.persist({ kind: 'node', payload: node })
    return node
  }

  async addEdge(args: AddEdgeArgs): Promise<GraphEdge> {
    if (!this.loaded) await this.load()
    if (!this.nodes.has(args.from)) {
      throw new Error(`addEdge: unknown from-node ${args.from}`)
    }
    if (!this.nodes.has(args.to)) {
      throw new Error(`addEdge: unknown to-node ${args.to}`)
    }

    const now = new Date().toISOString()
    const id = args.id ?? randomUUID()
    const edge: GraphEdge = {
      id,
      from: args.from,
      to: args.to,
      rel: args.rel,
      props: args.props ?? {},
      valid_from: args.valid_from ?? now,
      valid_to: null,
      recorded_at: now,
    }

    // Supersede existing valid edges matching (from, rel).
    //
    // Semantic: a new edge like (u, LIVES_IN, Berlin) supersedes any prior
    // (u, LIVES_IN, *) — because LIVES_IN is single-valued per subject.
    // If the relation is multi-valued (e.g. KNOWS), callers should NOT pass
    // supersede=true and should manage edges explicitly.
    if (args.supersede) {
      const victims: GraphEdge[] = []
      for (const eid of this.outIdx.get(args.from) ?? []) {
        const e = this.edges.get(eid)!
        if (e.rel === args.rel && e.valid_to == null && e.id !== id) {
          victims.push(e)
        }
      }
      for (const v of victims) {
        const retired: GraphEdge = { ...v, valid_to: edge.valid_from, superseded_by: id }
        this.edges.set(v.id, retired)
        await this.persist({ kind: 'edge', payload: retired })
      }
    }

    this.edges.set(edge.id, edge)
    this.indexEdge(edge)
    await this.persist({ kind: 'edge', payload: edge })
    return edge
  }

  async retractEdge(id: string, at: string = new Date().toISOString()): Promise<GraphEdge | null> {
    if (!this.loaded) await this.load()
    const e = this.edges.get(id)
    if (!e) return null
    if (e.valid_to != null) return e // already retracted
    const retired: GraphEdge = { ...e, valid_to: at }
    this.edges.set(id, retired)
    await this.persist({ kind: 'edge_retract', payload: retired })
    return retired
  }

  /**
   * Query edges by filter. asOf implements temporal point-in-time lookup —
   * returns the edges that were "true" at that moment.
   */
  query(q: GraphQuery = {}): GraphEdge[] {
    const asOfMs = q.asOf ? Date.parse(q.asOf) : undefined
    const out: GraphEdge[] = []

    const iter = q.from
      ? iterateSet(this.outIdx.get(q.from), this.edges)
      : q.to
        ? iterateSet(this.inIdx.get(q.to), this.edges)
        : this.edges.values()

    for (const e of iter) {
      if (q.from && e.from !== q.from) continue
      if (q.to && e.to !== q.to) continue
      if (q.rel && e.rel !== q.rel) continue
      if (!q.includeInvalid && !isEdgeValidAt(e, asOfMs)) continue
      out.push(e)
      if (q.limit && out.length >= q.limit) break
    }
    return out
  }

  /**
   * BFS traversal from a seed node up to `depth` hops. Returns the reached
   * nodes each with the edge path that got us there.
   */
  neighbors(seed: string, q: NeighborQuery = {}): NeighborResult[] {
    const depth = Math.max(1, q.depth ?? 1)
    const direction = q.direction ?? 'out'
    const asOfMs = q.asOf ? Date.parse(q.asOf) : undefined
    const limit = q.limit ?? Infinity

    if (!this.nodes.has(seed)) return []

    const results: NeighborResult[] = []
    const visited = new Set<string>([seed])
    type Frame = { id: string; path: GraphEdge[]; hops: number }
    const queue: Frame[] = [{ id: seed, path: [], hops: 0 }]
    // Head pointer instead of queue.shift() — avoids O(n) array re-indexing
    // on every dequeue, so traversal stays O(V+E).
    let head = 0

    while (head < queue.length && results.length < limit) {
      const frame = queue[head++]!
      if (frame.hops >= depth) continue

      const edgeIds =
        direction === 'out'
          ? this.outIdx.get(frame.id) ?? new Set<string>()
          : direction === 'in'
            ? this.inIdx.get(frame.id) ?? new Set<string>()
            : new Set<string>([
                ...(this.outIdx.get(frame.id) ?? []),
                ...(this.inIdx.get(frame.id) ?? []),
              ])

      for (const eid of edgeIds) {
        const edge = this.edges.get(eid)!
        if (q.rel && edge.rel !== q.rel) continue
        if (!q.includeInvalid && !isEdgeValidAt(edge, asOfMs)) continue
        const next = edge.from === frame.id ? edge.to : edge.from
        if (visited.has(next)) continue
        visited.add(next)
        const node = this.nodes.get(next)
        if (!node) continue
        const path = [...frame.path, edge]
        const hops = frame.hops + 1
        results.push({ node, path, depth: hops })
        if (results.length >= limit) break
        queue.push({ id: next, path, hops })
      }
    }
    return results
  }

  /**
   * Iterator over all currently-valid edges (no filter). Handy for bulk
   * operations like re-index / export.
   */
  *validEdges(asOf?: string): Iterable<GraphEdge> {
    const asOfMs = asOf ? Date.parse(asOf) : undefined
    for (const e of this.edges.values()) {
      if (isEdgeValidAt(e, asOfMs)) yield e
    }
  }

  // ─── internal ──────────────────────────────────────────────────────────

  private apply(evt: Event): void {
    if (evt.kind === 'node') {
      const n = evt.payload as GraphNode
      this.nodes.set(n.id, n)
    } else if (evt.kind === 'edge' || evt.kind === 'edge_retract') {
      const e = evt.payload as GraphEdge
      this.edges.set(e.id, e)
      this.indexEdge(e)
    }
  }

  private indexEdge(e: GraphEdge): void {
    const out = this.outIdx.get(e.from) ?? new Set<string>()
    out.add(e.id)
    this.outIdx.set(e.from, out)
    const inn = this.inIdx.get(e.to) ?? new Set<string>()
    inn.add(e.id)
    this.inIdx.set(e.to, inn)
  }

  private async persist(evt: Event): Promise<void> {
    if (!this.path) return
    await appendJsonl(this.path, evt)
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function stableId(prefix: string, ...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16)
  return `${prefix}-${h}`
}

function* iterateSet<T>(
  ids: Set<string> | undefined,
  lookup: Map<string, T>,
): Generator<T> {
  if (!ids) return
  for (const id of ids) {
    const v = lookup.get(id)
    if (v !== undefined) yield v
  }
}

function isEdgeValidAt(edge: GraphEdge, asOfMs?: number): boolean {
  if (asOfMs === undefined) return edge.valid_to == null
  const fromMs = Date.parse(edge.valid_from)
  if (asOfMs < fromMs) return false
  if (edge.valid_to == null) return true
  return asOfMs < Date.parse(edge.valid_to)
}

// ─── GraphBackend interface (for future FalkorDB / Neo4j adapters) ───────

/**
 * The interface any graph backend must satisfy. GraphStore is the reference
 * in-process implementation; production backends (FalkorDB via ioredis, Neo4j
 * via the official driver) implement the same surface.
 */
export interface GraphBackend {
  load(): Promise<void>
  addNode(args: AddNodeArgs): Promise<GraphNode>
  addEdge(args: AddEdgeArgs): Promise<GraphEdge>
  retractEdge(id: string, at?: string): Promise<GraphEdge | null>
  query(q?: GraphQuery): Promise<GraphEdge[]> | GraphEdge[]
  neighbors(seed: string, q?: NeighborQuery): Promise<NeighborResult[]> | NeighborResult[]
}
