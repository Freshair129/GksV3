/**
 * Link checker tests (ADR-014 item 6).
 */

import { describe, it, expect } from 'vitest'
import type { AtomicEntry } from '../../src/memory/types.js'
import { validateLinks, formatValidateLinksResult } from '../../src/memory/validate-links.js'

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

describe('validateLinks', () => {
  it('returns ok=true when every crosslink resolves', () => {
    const result = validateLinks(
      map([
        entry({ id: 'A--1', crosslinks: { references: ['A--2'] } }),
        entry({ id: 'A--2' }),
      ]),
    )
    expect(result.ok).toBe(true)
    expect(result.scanned).toBe(2)
    expect(result.errors).toHaveLength(0)
  })

  it('reports broken links across every crosslink key (not just verify-flow ones)', () => {
    const result = validateLinks(
      map([
        entry({
          id: 'A--1',
          crosslinks: {
            references: ['A--MISSING'],
            custom_link: ['A--ALSO-MISSING'],
            parent_blueprint: ['A--2'],
          },
        }),
        entry({ id: 'A--2' }),
      ]),
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(2)
    expect(result.errors.map((e) => e.target).sort()).toEqual(['A--ALSO-MISSING', 'A--MISSING'])
  })

  it('skips empty / non-array crosslink values without throwing', () => {
    const result = validateLinks(
      map([
        entry({
          id: 'A--1',
          crosslinks: {
            references: [],
            // @ts-expect-error — exercise the runtime guard against malformed input
            broken: 'not-an-array',
          },
        }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  it('formatValidateLinksResult emits human-readable lines', () => {
    const result = validateLinks(
      map([entry({ id: 'A--1', crosslinks: { references: ['A--GHOST'] } })]),
    )
    const lines = formatValidateLinksResult(result)
    expect(lines.some((l) => l.includes('FAILED'))).toBe(true)
    expect(lines.some((l) => l.includes('A--GHOST'))).toBe(true)
  })
})
