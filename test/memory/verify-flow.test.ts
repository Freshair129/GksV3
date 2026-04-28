/**
 * Chain walker tests (ADR-014 item 3).
 */

import { describe, it, expect } from 'vitest'
import type { AtomicEntry } from '../../src/memory/types.js'
import { verifyFlow, formatVerifyFlowResult } from '../../src/memory/verify-flow.js'

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

function map(entries: AtomicEntry[]): Map<string, AtomicEntry> {
  const m = new Map<string, AtomicEntry>()
  for (const e of entries) m.set(e.id, e)
  return m
}

describe('verifyFlow', () => {
  it('returns ok=true when every node in the chain is stable', () => {
    const byId = map([
      entry({
        id: 'FEAT--X',
        crosslinks: { references: ['ADR--X'], implements: ['CONCEPT--X'] },
      }),
      entry({ id: 'ADR--X', type: 'adr' }),
      entry({ id: 'CONCEPT--X', type: 'concept' }),
    ])
    const result = verifyFlow('FEAT--X', byId)
    expect(result.ok).toBe(true)
    expect(result.visited).toHaveLength(3)
    expect(result.errors).toHaveLength(0)
  })

  it('reports missing start atom', () => {
    const result = verifyFlow('FEAT--MISSING', map([]))
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.kind).toBe('missing')
  })

  it('reports a not_approved status without aborting the walk', () => {
    const byId = map([
      entry({ id: 'FEAT--X', crosslinks: { references: ['ADR--X'] } }),
      entry({ id: 'ADR--X', type: 'adr', status: 'draft' }),
    ])
    const result = verifyFlow('FEAT--X', byId)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.kind).toBe('not_approved')
    expect(result.errors[0]?.id).toBe('ADR--X')
  })

  it('reports a broken crosslink without crashing', () => {
    const byId = map([
      entry({ id: 'FEAT--X', crosslinks: { references: ['ADR--GHOST'] } }),
    ])
    const result = verifyFlow('FEAT--X', byId)
    expect(result.ok).toBe(false)
    const broken = result.errors.find((e) => e.kind === 'broken_crosslink')
    expect(broken?.target).toBe('ADR--GHOST')
    expect(broken?.via).toBe('references')
  })

  it('honours the approved alias on the gate (status: approved → stable)', () => {
    const byId = map([
      entry({ id: 'FEAT--X', crosslinks: { references: ['ADR--X'] } }),
      // simulate frontmatter authored against master-spec wording
      entry({ id: 'ADR--X', type: 'adr', status: 'approved' as 'stable' }),
    ])
    const result = verifyFlow('FEAT--X', byId)
    expect(result.ok).toBe(true)
  })

  it('handles cycles (each atom visited once)', () => {
    const byId = map([
      entry({ id: 'A--1', crosslinks: { references: ['A--2'] } }),
      entry({ id: 'A--2', crosslinks: { references: ['A--1'] } }),
    ])
    const result = verifyFlow('A--1', byId)
    expect(result.ok).toBe(true)
    expect(result.visited).toHaveLength(2)
  })

  it('walks parent_blueprint and resolves edges', () => {
    const byId = map([
      entry({
        id: 'TASK--T1',
        type: 'task',
        crosslinks: { parent_blueprint: ['BLUEPRINT--X'], resolves: ['HOTFIX--ABC1234'] },
      }),
      entry({ id: 'BLUEPRINT--X', type: 'blueprint' }),
      entry({ id: 'HOTFIX--ABC1234', type: 'hotfix', phase: 5 }),
    ])
    const result = verifyFlow('TASK--T1', byId)
    expect(result.ok).toBe(true)
    expect(result.edges.map((e) => e.via).sort()).toEqual(['parent_blueprint', 'resolves'])
  })

  it('formatVerifyFlowResult produces human-readable lines', () => {
    const byId = map([
      entry({ id: 'FEAT--X', crosslinks: { references: ['ADR--GHOST'] } }),
    ])
    const lines = formatVerifyFlowResult(verifyFlow('FEAT--X', byId))
    expect(lines.some((l) => l.includes('FAILED'))).toBe(true)
    expect(lines.some((l) => l.includes('ADR--GHOST'))).toBe(true)
  })
})
