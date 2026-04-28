/**
 * HotfixStore unit tests — exercise open / list / close / overdue gating
 * against a real tmpdir. Hermetic: no network, no MemoryStore needed
 * (hotfixes are an independent light-tier store per ADR-014).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HotfixStore } from '../../src/hotfix/store.js'
import { HOTFIX_BACKFILL_MS, isOverdue, makeHotfixId, validateHotfix } from '../../src/hotfix/types.js'

describe('HotfixStore', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-hotfix-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('open() writes a well-formed atom with valid_to = now + 48h', async () => {
    const store = new HotfixStore({ root })
    const before = Date.now()
    const hotfix = await store.open({
      commitSha: 'abc1234567890def',
      title: 'prod down: rate limiter overflow',
      files: ['src/api/rate-limit.ts'],
      reason: 'customer escalation',
    })
    expect(hotfix.id).toBe('HOTFIX--ABC1234')
    expect(hotfix.type).toBe('hotfix')
    expect(hotfix.phase).toBe(5)
    expect(validateHotfix(hotfix).valid).toBe(true)
    const validToMs = new Date(hotfix.valid_to).getTime()
    expect(validToMs - before).toBeGreaterThanOrEqual(HOTFIX_BACKFILL_MS - 2_000)
    expect(validToMs - before).toBeLessThanOrEqual(HOTFIX_BACKFILL_MS + 2_000)
    const text = await readFile(join(root, 'gks', 'hotfix', 'HOTFIX--ABC1234.md'), 'utf8')
    expect(text).toContain('id: HOTFIX--ABC1234')
    expect(text).toContain('type: hotfix')
    expect(text).toContain('src/api/rate-limit.ts')
  })

  it('list() returns every hotfix on disk', async () => {
    const store = new HotfixStore({ root })
    await store.open({ commitSha: 'aaa0000', title: 'first' })
    await store.open({ commitSha: 'bbb0000', title: 'second' })
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all.map((h) => h.id).sort()).toEqual(['HOTFIX--AAA0000', 'HOTFIX--BBB0000'])
  })

  it('listOverdue() filters by valid_to < now and not-closed', async () => {
    const store = new HotfixStore({ root })
    const future = await store.open({ commitSha: 'fff0000', title: 'future' })
    expect(await store.listOverdue()).toHaveLength(0)

    // Manually backdate one atom's valid_to to simulate overdue.
    const path = join(root, 'gks', 'hotfix', `${future.id}.md`)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace(/valid_to: .+/, 'valid_to: 2020-01-01T00:00:00Z'))
    const overdue = await store.listOverdue()
    expect(overdue).toHaveLength(1)
    expect(overdue[0]?.id).toBe(future.id)
  })

  it('close() sets closed_at + crosslinks.resolved_by; subsequent listOverdue excludes it', async () => {
    const store = new HotfixStore({ root })
    const opened = await store.open({ commitSha: 'ccc0000', title: 'closed-soon' })
    // Backdate to simulate overdue first.
    const path = join(root, 'gks', 'hotfix', `${opened.id}.md`)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace(/valid_to: .+/, 'valid_to: 2020-01-01T00:00:00Z'))
    expect(await store.listOverdue()).toHaveLength(1)

    const closed = await store.close(opened.id, ['ADR--FIX-IT'])
    expect(closed.closed_at).toBeDefined()
    expect(closed.crosslinks?.resolved_by).toEqual(['ADR--FIX-IT'])
    expect(await store.listOverdue()).toHaveLength(0)
  })

  it('isOverdue() honours closed_at regardless of valid_to', () => {
    const past = '2020-01-01T00:00:00Z'
    const stillOpen = {
      id: 'HOTFIX--AAA0000', phase: 5 as const, type: 'hotfix' as const,
      status: 'stable' as const, title: 't',
      created_at: past, valid_from: past, valid_to: past,
      meta: { commit_sha: 'aaa' },
    }
    expect(isOverdue(stillOpen)).toBe(true)
    expect(isOverdue({ ...stillOpen, closed_at: '2020-02-01T00:00:00Z' })).toBe(false)
  })

  it('makeHotfixId() derives a 7-char uppercase short SHA', () => {
    expect(makeHotfixId('abc1234567890')).toBe('HOTFIX--ABC1234')
    expect(makeHotfixId('DEADBEEFcafe')).toBe('HOTFIX--DEADBEE')
  })
})
