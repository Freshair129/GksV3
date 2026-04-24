import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { AtomicLayer, openAtomicLayer } from '../../src/memory/gks.js'

const INDEX = resolve(__dirname, '..', 'fixtures', 'gks', '00_index', 'atomic_index.jsonl')
const GKS_ROOT = resolve(__dirname, '..', 'fixtures', 'gks')

describe('AtomicLayer', () => {
  it('loads the JSONL index', async () => {
    const layer = new AtomicLayer({ indexPath: INDEX, gksRoot: GKS_ROOT })
    const entries = await layer.loadIndex()
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.id)).toContain('CONCEPT--EVA-TRI-BRAIN')
  })

  it('lookup() returns a full note with body by exact ID', async () => {
    const layer = await openAtomicLayer(INDEX)
    // openAtomicLayer doesn't set gksRoot, but the fixture structure lines up
    // because gks/ is two levels above the index file.
    const note = await layer.lookup('CONCEPT--EVA-TRI-BRAIN')
    expect(note).not.toBeNull()
    expect(note!.title).toBe('EVA Tri-Brain')
    expect(note!.body).toContain('Three specialized cognitive modules')
  })

  it('lookup() returns null for unknown IDs (never hallucinates)', async () => {
    const layer = await openAtomicLayer(INDEX)
    const note = await layer.lookup('CONCEPT--DOES-NOT-EXIST')
    expect(note).toBeNull()
  })

  it('filter() selects by phase/type/status/tag', async () => {
    const layer = new AtomicLayer({ indexPath: INDEX, gksRoot: GKS_ROOT })
    await layer.loadIndex()

    expect(layer.filter({ phase: 1 }).map((e) => e.id)).toEqual(['CONCEPT--EVA-TRI-BRAIN'])
    expect(layer.filter({ type: 'adr' }).map((e) => e.id)).toEqual(['ADR--FILE-BASED-VECTOR'])
    expect(layer.filter({ status: 'stable' })).toHaveLength(2)
    expect(layer.filter({ tag: 'architecture' })).toHaveLength(2)
  })

  it('filter() throws if called before loadIndex()', () => {
    const layer = new AtomicLayer({ indexPath: INDEX, gksRoot: GKS_ROOT })
    expect(() => layer.filter({ phase: 1 })).toThrow(/loadIndex/)
  })

  it('searchById() returns a hit with matchedBy="id"', async () => {
    const layer = await openAtomicLayer(INDEX)
    const hit = await layer.searchById('ADR--FILE-BASED-VECTOR')
    expect(hit).not.toBeNull()
    expect(hit!.matchedBy).toBe('id')
    expect(hit!.score).toBe(1)
    expect(hit!.note.id).toBe('ADR--FILE-BASED-VECTOR')
  })

  it('gracefully handles missing index file', async () => {
    const layer = new AtomicLayer({
      indexPath: '/nonexistent/atomic_index.jsonl',
    })
    const entries = await layer.loadIndex()
    expect(entries).toEqual([])
    expect(layer.size()).toBe(0)
  })
})
