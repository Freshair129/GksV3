import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicLayer } from '../../src/memory/gks.js'
import {
  deriveBacklinks,
  deriveBacklinksFromEntries,
  emitBacklinks,
} from '../../src/memory/backlinks.js'
import type { AtomicEntry } from '../../src/memory/types.js'

function entry(p: Partial<AtomicEntry> & { id: string }): AtomicEntry {
  return {
    phase: 2,
    type: 'concept',
    status: 'stable',
    vault_id: 'default',
    path: `gks/concept/${p.id}.md`,
    ...p,
  }
}

async function writeIndex(dir: string, entries: AtomicEntry[]): Promise<string> {
  const indexDir = join(dir, '00_index')
  await mkdir(indexDir, { recursive: true })
  const indexPath = join(indexDir, 'atomic_index.jsonl')
  await writeFile(indexPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return indexPath
}

describe('deriveBacklinks', () => {
  it('emits one edge per crosslink target', () => {
    const edges = deriveBacklinksFromEntries([
      entry({
        id: 'FEAT--X',
        crosslinks: { references: ['ADR--X', 'CONCEPT--X'], implements: ['CONCEPT--Y'] },
      }),
      entry({ id: 'ADR--X', type: 'adr' }),
    ])
    expect(edges).toEqual([
      { from: 'FEAT--X', to: 'ADR--X', type: 'references' },
      { from: 'FEAT--X', to: 'CONCEPT--X', type: 'references' },
      { from: 'FEAT--X', to: 'CONCEPT--Y', type: 'implements' },
    ])
  })

  it('sorts deterministically by (from, to, type)', () => {
    const edges = deriveBacklinksFromEntries([
      entry({ id: 'B', crosslinks: { references: ['Z', 'A'] } }),
      entry({ id: 'A', crosslinks: { references: ['Y'], implements: ['Y'] } }),
    ])
    expect(edges.map((e) => `${e.from}->${e.to}:${e.type}`)).toEqual([
      'A->Y:implements',
      'A->Y:references',
      'B->A:references',
      'B->Z:references',
    ])
  })

  it('filters by crosslink type when filterTypes is set', () => {
    const edges = deriveBacklinksFromEntries(
      [
        entry({
          id: 'FEAT--X',
          crosslinks: {
            references: ['ADR--X'],
            implements: ['CONCEPT--X'],
            superseded_by: ['FEAT--Y'],
          },
        }),
      ],
      { filterTypes: ['references', 'superseded_by'] },
    )
    expect(edges.map((e) => e.type).sort()).toEqual(['references', 'superseded_by'])
  })

  it('skips entries with no crosslinks and ignores non-array values', () => {
    const edges = deriveBacklinksFromEntries([
      entry({ id: 'A' }),
      entry({
        id: 'B',
        // simulate a malformed index row — non-array crosslink value
        crosslinks: { references: 'not-an-array' as unknown as string[] },
      }),
      entry({ id: 'C', crosslinks: { references: ['D'] } }),
    ])
    expect(edges).toEqual([{ from: 'C', to: 'D', type: 'references' }])
  })

  it('loads from an AtomicLayer and produces matching results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gks-backlinks-'))
    try {
      const indexPath = await writeIndex(dir, [
        entry({ id: 'FEAT--X', crosslinks: { references: ['ADR--Y'] } }),
        entry({ id: 'ADR--Y', type: 'adr' }),
      ])
      const layer = new AtomicLayer({ indexPath })
      const edges = await deriveBacklinks(layer)
      expect(edges).toEqual([{ from: 'FEAT--X', to: 'ADR--Y', type: 'references' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('emitBacklinks', () => {
  it('writes a JSONL file by default with one edge per line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gks-backlinks-emit-'))
    try {
      const indexPath = await writeIndex(dir, [
        entry({ id: 'A', crosslinks: { references: ['B'] } }),
        entry({ id: 'B', crosslinks: { references: ['C'] } }),
      ])
      const layer = new AtomicLayer({ indexPath })
      const out = join(dir, 'out', 'backlinks.jsonl')
      const result = await emitBacklinks(layer, out)
      expect(result.edgeCount).toBe(2)
      const text = await readFile(out, 'utf8')
      const lines = text.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toEqual({ from: 'A', to: 'B', type: 'references' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes a JSON array when format=json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gks-backlinks-emit-json-'))
    try {
      const indexPath = await writeIndex(dir, [
        entry({ id: 'A', crosslinks: { references: ['B'] } }),
      ])
      const layer = new AtomicLayer({ indexPath })
      const out = join(dir, 'backlinks.json')
      await emitBacklinks(layer, out, { format: 'json' })
      const text = await readFile(out, 'utf8')
      expect(JSON.parse(text)).toEqual([{ from: 'A', to: 'B', type: 'references' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
