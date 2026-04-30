/**
 * PocStore unit tests — exercise open / start / close / list / overdue
 * gating against a real tmpdir. Hermetic: no network, no MemoryStore.
 *
 * Mirrors test/hotfix/store.test.ts shape (same light-tier pattern per
 * ADR--ADD-POC-PREFIX).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PocStore } from '../../src/poc/store.js'
import { isClosed, isOverdue, makePocId, validatePoc } from '../../src/poc/types.js'

const FUTURE_DEADLINE = '2099-01-01T00:00:00Z'
const PAST_DEADLINE = '2020-01-01T00:00:00Z'

function openArgs(overrides: Partial<Parameters<PocStore['open']>[0]> = {}) {
  return {
    slug: 'demo-hypothesis',
    title: 'Demo POC',
    hypothesis: 'X works under condition Y',
    acceptanceCriteria: ['metric M ≥ 0.8 on dataset D'],
    deadline: FUTURE_DEADLINE,
    ...overrides,
  }
}

describe('PocStore', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-poc-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('open() writes a well-formed atom with status=open and required fields', async () => {
    const store = new PocStore({ root })
    const poc = await store.open(openArgs({ files: ['examples/demo/'] }))
    expect(poc.id).toBe('POC--DEMO-HYPOTHESIS')
    expect(poc.type).toBe('poc')
    expect(poc.phase).toBe(1)
    expect(poc.status).toBe('open')
    expect(poc.hypothesis).toContain('X works')
    expect(poc.acceptance_criteria).toHaveLength(1)
    expect(poc.time_box.deadline).toBe(FUTURE_DEADLINE)
    expect(poc.time_box.closed_at).toBeNull()
    expect(validatePoc(poc).valid).toBe(true)

    const text = await readFile(join(root, 'gks', 'poc', 'POC--DEMO-HYPOTHESIS.md'), 'utf8')
    expect(text).toContain('id: POC--DEMO-HYPOTHESIS')
    expect(text).toContain('type: poc')
    expect(text).toContain('hypothesis:')
    expect(text).toContain('examples/demo/')
  })

  it('makePocId normalises slugs into POC--<UPPER-WITH-DASHES>', () => {
    expect(makePocId('memory os architecture')).toBe('POC--MEMORY-OS-ARCHITECTURE')
    expect(makePocId('foo_bar.baz')).toBe('POC--FOO-BAR-BAZ')
    expect(makePocId('  spaced  ')).toBe('POC--SPACED')
  })

  it('validatePoc rejects missing hypothesis, deadline, or acceptance_criteria', () => {
    const baseId = 'POC--MISSING-FIELDS'
    expect(
      validatePoc({
        id: baseId,
        type: 'poc',
        phase: 1,
        status: 'open',
        title: 't',
        hypothesis: '',
        acceptance_criteria: [],
        time_box: { opened_at: '2026-01-01T00:00:00Z', deadline: '' },
      }).valid,
    ).toBe(false)

    expect(
      validatePoc({
        id: baseId,
        type: 'poc',
        phase: 1,
        status: 'validated',
        title: 't',
        hypothesis: 'h',
        acceptance_criteria: ['c'],
        // closed_at missing despite terminal status
        time_box: { opened_at: '2026-01-01T00:00:00Z', deadline: FUTURE_DEADLINE },
      }).valid,
    ).toBe(false)
  })

  it('start() transitions open → running', async () => {
    const store = new PocStore({ root })
    const poc = await store.open(openArgs())
    const running = await store.start(poc.id)
    expect(running.status).toBe('running')
  })

  it('close() sets resolution + closed_at + crosslinks.feeds_into', async () => {
    const store = new PocStore({ root })
    const poc = await store.open(openArgs())
    const closed = await store.close(poc.id, {
      resolution: 'validated',
      feedsInto: ['ADR--FOO'],
      produces: ['AUDIT--FOO-RESULTS'],
    })
    expect(closed.status).toBe('validated')
    expect(closed.time_box.closed_at).toBeTruthy()
    expect(closed.crosslinks?.feeds_into).toEqual(['ADR--FOO'])
    expect(closed.crosslinks?.produces).toEqual(['AUDIT--FOO-RESULTS'])
    expect(isClosed(closed)).toBe(true)
  })

  it('list() returns every POC sorted by opened_at desc', async () => {
    const store = new PocStore({ root })
    await store.open(openArgs({ slug: 'first' }))
    await store.open(openArgs({ slug: 'second' }))
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all.map((p) => p.id).sort()).toEqual(['POC--FIRST', 'POC--SECOND'])
  })

  it('listOverdue() filters by deadline < now AND status in {open, running}', async () => {
    const store = new PocStore({ root })
    const future = await store.open(openArgs({ slug: 'future' }))
    expect(await store.listOverdue()).toHaveLength(0)

    // Backdate deadline to simulate overdue. yamlLite renders nested
    // objects inline as JSON, so the deadline lives inside a JSON blob.
    const path = join(root, 'gks', 'poc', `${future.id}.md`)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace(/"deadline":"[^"]+"/, `"deadline":"${PAST_DEADLINE}"`))
    const overdue = await store.listOverdue()
    expect(overdue).toHaveLength(1)
    expect(overdue[0]?.id).toBe(future.id)

    // Closing it removes from overdue list.
    await store.close(future.id, { resolution: 'abandoned' })
    expect(await store.listOverdue()).toHaveLength(0)
  })

  it('isOverdue is false for terminal-status POCs even past deadline', () => {
    const opened_at = '2020-01-01T00:00:00Z'
    const deadline = '2020-02-01T00:00:00Z'
    const closed_at = '2020-02-15T00:00:00Z'
    const validated = {
      id: 'POC--T',
      type: 'poc' as const,
      phase: 1 as const,
      status: 'validated' as const,
      title: 't',
      hypothesis: 'h',
      acceptance_criteria: ['c'],
      time_box: { opened_at, deadline, closed_at },
    }
    expect(isOverdue(validated, new Date('2099-01-01'))).toBe(false)
  })

  it('roundtrip: open → start → close → re-list preserves all custom fields', async () => {
    const store = new PocStore({ root })
    const poc = await store.open(
      openArgs({
        slug: 'roundtrip',
        files: ['examples/foo/'],
        derivesFrom: ['CONCEPT--BAR'],
      }),
    )
    await store.start(poc.id)
    await store.close(poc.id, { resolution: 'invalidated', feedsInto: ['ADR--BAZ'] })
    const reread = (await store.list())[0]!
    expect(reread.status).toBe('invalidated')
    expect(reread.hypothesis).toContain('X works')
    expect(reread.acceptance_criteria).toHaveLength(1)
    expect(reread.linked_symbols?.[0]?.file).toBe('examples/foo/')
    expect(reread.crosslinks?.derives_from).toEqual(['CONCEPT--BAR'])
    expect(reread.crosslinks?.feeds_into).toEqual(['ADR--BAZ'])
    expect(reread.time_box.closed_at).toBeTruthy()
  })
})
