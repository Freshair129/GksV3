import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/memory/graph.js'

describe('GraphStore (in-memory)', () => {
  it('adds nodes and edges and indexes both directions', async () => {
    const g = new GraphStore()
    await g.load()
    const alice = await g.addNode({ id: 'u:alice', labels: ['User'], props: { name: 'Alice' } })
    const bob = await g.addNode({ id: 'u:bob', labels: ['User'], props: { name: 'Bob' } })
    const e = await g.addEdge({ from: alice.id, to: bob.id, rel: 'KNOWS' })
    expect(g.size()).toEqual({ nodes: 2, edges: 1 })
    expect(g.query({ from: alice.id })).toHaveLength(1)
    expect(g.query({ to: bob.id })).toHaveLength(1)
    expect(g.query({ rel: 'FOLLOWS' })).toHaveLength(0)
    void e
  })

  it('rejects edges to unknown nodes', async () => {
    const g = new GraphStore()
    await g.load()
    await g.addNode({ id: 'a', labels: ['X'] })
    await expect(g.addEdge({ from: 'a', to: 'ghost', rel: 'R' })).rejects.toThrow(/unknown to-node/)
  })

  it('supersede marks prior valid edges invalid and points them at the new one', async () => {
    const g = new GraphStore()
    await g.load()
    await g.addNode({ id: 'u', labels: ['User'] })
    await g.addNode({ id: 'city:paris', labels: ['City'], props: { name: 'Paris' } })
    await g.addNode({ id: 'city:berlin', labels: ['City'], props: { name: 'Berlin' } })

    const first = await g.addEdge({ from: 'u', to: 'city:paris', rel: 'LIVES_IN', valid_from: '2022-01-01T00:00:00Z' })
    const second = await g.addEdge({ from: 'u', to: 'city:paris', rel: 'LIVES_IN', valid_from: '2024-06-01T00:00:00Z', supersede: true })

    // The first edge now has valid_to set and superseded_by pointing at the second.
    const retired = g.getEdge(first.id)!
    expect(retired.valid_to).toBe(second.valid_from)
    expect(retired.superseded_by).toBe(second.id)

    // Default query hides retired edges.
    const current = g.query({ from: 'u', rel: 'LIVES_IN' })
    expect(current.map((e) => e.to)).toEqual(['city:paris']) // just the new one
    expect(current).toHaveLength(1)
    expect(current[0]!.id).toBe(second.id)
  })

  it('supersede does NOT touch edges with different (from,to,rel)', async () => {
    const g = new GraphStore()
    await g.load()
    await g.addNode({ id: 'u', labels: ['User'] })
    await g.addNode({ id: 'p', labels: ['City'] })
    await g.addNode({ id: 'b', labels: ['City'] })
    const a = await g.addEdge({ from: 'u', to: 'p', rel: 'LIVES_IN' })
    await g.addEdge({ from: 'u', to: 'b', rel: 'VISITED', supersede: true }) // different to+rel
    expect(g.getEdge(a.id)!.valid_to).toBeNull()
  })

  it('asOf returns edges valid at that point in time', async () => {
    const g = new GraphStore()
    await g.load()
    await g.addNode({ id: 'u', labels: ['User'] })
    await g.addNode({ id: 'p', labels: ['City'] })
    await g.addNode({ id: 'b', labels: ['City'] })
    await g.addEdge({ from: 'u', to: 'p', rel: 'LIVES_IN', valid_from: '2022-01-01T00:00:00Z' })
    await g.addEdge({ from: 'u', to: 'b', rel: 'LIVES_IN', valid_from: '2024-06-01T00:00:00Z', supersede: true })

    const in2023 = g.query({ from: 'u', rel: 'LIVES_IN', asOf: '2023-06-01T00:00:00Z' })
    expect(in2023.map((e) => e.to)).toEqual(['p'])

    const in2025 = g.query({ from: 'u', rel: 'LIVES_IN', asOf: '2025-01-01T00:00:00Z' })
    expect(in2025.map((e) => e.to)).toEqual(['b'])
  })

  it('retractEdge invalidates but preserves history', async () => {
    const g = new GraphStore()
    await g.load()
    await g.addNode({ id: 'a', labels: ['X'] })
    await g.addNode({ id: 'b', labels: ['X'] })
    const e = await g.addEdge({ from: 'a', to: 'b', rel: 'R' })
    const retracted = await g.retractEdge(e.id, '2025-01-01T00:00:00Z')
    expect(retracted?.valid_to).toBe('2025-01-01T00:00:00Z')

    expect(g.query({ from: 'a' })).toHaveLength(0) // hidden
    expect(g.query({ from: 'a', includeInvalid: true })).toHaveLength(1)
  })

  it('neighbors() BFS respects depth + relation + direction', async () => {
    const g = new GraphStore()
    await g.load()
    for (const id of ['a', 'b', 'c', 'd']) await g.addNode({ id, labels: ['X'] })
    await g.addEdge({ from: 'a', to: 'b', rel: 'R' })
    await g.addEdge({ from: 'b', to: 'c', rel: 'R' })
    await g.addEdge({ from: 'c', to: 'd', rel: 'R' })

    const depth1 = g.neighbors('a', { depth: 1 })
    expect(depth1.map((n) => n.node.id)).toEqual(['b'])

    const depth2 = g.neighbors('a', { depth: 2 })
    expect(depth2.map((n) => n.node.id).sort()).toEqual(['b', 'c'])

    const depth3 = g.neighbors('a', { depth: 3 })
    expect(depth3.map((n) => n.node.id).sort()).toEqual(['b', 'c', 'd'])

    // 'in' direction from 'd'
    const inbound = g.neighbors('d', { depth: 3, direction: 'in' })
    expect(inbound.map((n) => n.node.id)).toEqual(['c', 'b', 'a'])
  })

  it('neighbors path carries the edge sequence', async () => {
    const g = new GraphStore()
    await g.load()
    for (const id of ['a', 'b', 'c']) await g.addNode({ id, labels: ['X'] })
    const e1 = await g.addEdge({ from: 'a', to: 'b', rel: 'R' })
    const e2 = await g.addEdge({ from: 'b', to: 'c', rel: 'R' })
    const depth2 = g.neighbors('a', { depth: 2 })
    const c = depth2.find((n) => n.node.id === 'c')!
    expect(c.path.map((e) => e.id)).toEqual([e1.id, e2.id])
  })
})

describe('GraphStore (persisted JSONL)', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gks-graph-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('persists and reloads node + edge state', async () => {
    const path = join(dir, 'graph.jsonl')
    const g1 = new GraphStore({ path })
    await g1.load()
    await g1.addNode({ id: 'a', labels: ['X'], props: { n: 1 } })
    await g1.addNode({ id: 'b', labels: ['X'] })
    await g1.addEdge({ from: 'a', to: 'b', rel: 'R', valid_from: '2025-01-01T00:00:00Z' })

    const g2 = new GraphStore({ path })
    await g2.load()
    expect(g2.size()).toEqual({ nodes: 2, edges: 1 })
    const edges = g2.query({ from: 'a' })
    expect(edges[0]!.rel).toBe('R')
  })

  it('retraction is replayable', async () => {
    const path = join(dir, 'graph.jsonl')
    const g1 = new GraphStore({ path })
    await g1.load()
    await g1.addNode({ id: 'a', labels: ['X'] })
    await g1.addNode({ id: 'b', labels: ['X'] })
    const e = await g1.addEdge({ from: 'a', to: 'b', rel: 'R' })
    await g1.retractEdge(e.id, '2025-06-01T00:00:00Z')

    const g2 = new GraphStore({ path })
    await g2.load()
    expect(g2.getEdge(e.id)!.valid_to).toBe('2025-06-01T00:00:00Z')
    expect(g2.query({ from: 'a' })).toHaveLength(0)
  })
})
