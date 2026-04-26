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

  describe('searchBySymbol (ADR-010 reverse citation lookup)', () => {
    function makeIndexed(entries: Array<Partial<{ id: string; type: string; linked_symbols: unknown[]; geography: string[] }>>) {
      const layer = new AtomicLayer({ indexPath: '/dev/null/never-loads' })
      // Bypass loadIndex by stubbing internal state; simpler than fs round-trip.
      const e = entries.map((row) => ({
        id: row.id ?? 'X',
        phase: 2,
        type: row.type ?? 'adr',
        status: 'stable',
        vault_id: 'V',
        path: 'p',
        title: row.id ?? 'X',
        ...(row.linked_symbols ? { linked_symbols: row.linked_symbols } : {}),
        ...(row.geography ? { geography: row.geography } : {}),
      })) as unknown as Parameters<AtomicLayer['filter']>[0][]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(layer as any).entries = e
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(layer as any).loaded = true
      return layer
    }

    it('matches exact file:fn citation', () => {
      const layer = makeIndexed([
        { id: 'A', linked_symbols: [{ file: 'src/x.ts', fn: 'foo' }] },
        { id: 'B', linked_symbols: [{ file: 'src/x.ts', fn: 'bar' }] },
      ])
      expect(layer.searchBySymbol('src/x.ts:foo').map((e) => e.id)).toEqual(['A'])
    })

    it('file-only query matches any fn in that file', () => {
      const layer = makeIndexed([
        { id: 'A', linked_symbols: [{ file: 'src/x.ts', fn: 'foo' }] },
        { id: 'B', linked_symbols: [{ file: 'src/x.ts', fn: 'bar' }] },
        { id: 'C', linked_symbols: [{ file: 'src/y.ts', fn: 'foo' }] },
      ])
      expect(layer.searchBySymbol('src/x.ts').map((e) => e.id).sort()).toEqual(['A', 'B'])
    })

    it('atom with file-only citation matches any fn query in that file', () => {
      const layer = makeIndexed([
        { id: 'BROAD', linked_symbols: [{ file: 'src/x.ts' }] },
        { id: 'NARROW', linked_symbols: [{ file: 'src/x.ts', fn: 'baz' }] },
      ])
      expect(layer.searchBySymbol('src/x.ts:foo').map((e) => e.id)).toEqual(['BROAD'])
    })

    it('blueprint geography citations work', () => {
      const layer = makeIndexed([
        { id: 'BP', type: 'blueprint', geography: ['src/stock/fefo.ts:applyFefo', 'src/stock/checkout.ts'] },
      ])
      expect(layer.searchBySymbol('src/stock/fefo.ts:applyFefo').map((e) => e.id)).toEqual(['BP'])
      expect(layer.searchBySymbol('src/stock/checkout.ts:processOrder').map((e) => e.id)).toEqual(['BP'])
      expect(layer.searchBySymbol('src/stock/other.ts')).toEqual([])
    })

    it('line-level match: enforced when both sides specify', () => {
      const layer = makeIndexed([
        { id: 'L42', linked_symbols: [{ file: 'src/x.ts', fn: 'foo', line: 42 }] },
      ])
      expect(layer.searchBySymbol('src/x.ts:foo:42').map((e) => e.id)).toEqual(['L42'])
      expect(layer.searchBySymbol('src/x.ts:foo:99')).toEqual([])
      // Query without line still matches (caller didn't constrain)
      expect(layer.searchBySymbol('src/x.ts:foo').map((e) => e.id)).toEqual(['L42'])
    })

    it('returns empty when no atoms cite the symbol', () => {
      const layer = makeIndexed([
        { id: 'A', linked_symbols: [{ file: 'src/x.ts', fn: 'foo' }] },
      ])
      expect(layer.searchBySymbol('src/never.ts:nope')).toEqual([])
    })

    it('returns empty for malformed query', () => {
      const layer = makeIndexed([
        { id: 'A', linked_symbols: [{ file: 'src/x.ts', fn: 'foo' }] },
      ])
      expect(layer.searchBySymbol('')).toEqual([])
    })

    it('throws if called before loadIndex()', () => {
      const layer = new AtomicLayer({ indexPath: '/dev/null/never-loaded' })
      expect(() => layer.searchBySymbol('src/x.ts')).toThrow(/loadIndex/)
    })
  })
})
