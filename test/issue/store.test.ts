/**
 * IssueStore unit tests — exercise create / list / show / comment /
 * setStatus / assign / close against a real tmpdir. Hermetic: no
 * network, no MemoryStore needed (issues are an independent storage
 * layer per ADR-012).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IssueStore } from '../../src/issue/store.js'
import { ISSUE_STATUSES, validateIssue } from '../../src/issue/types.js'

describe('IssueStore', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-issue-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('create() writes a well-formed .md and returns a valid Issue', async () => {
    const store = new IssueStore({ root })
    const issue = await store.create({
      title: 'My first issue',
      priority: 'high',
      labels: ['bug', 'perf'],
      assignee: 'MSP-AGT-RWANG',
    })
    expect(issue.id).toBe('ISSUE--MY-FIRST-ISSUE')
    expect(issue.status).toBe('open')
    expect(issue.priority).toBe('high')
    expect(issue.labels).toEqual(['bug', 'perf'])
    expect(validateIssue(issue).valid).toBe(true)

    const md = await readFile(join(root, 'gks/issues/ISSUE--MY-FIRST-ISSUE.md'), 'utf8')
    expect(md).toMatch(/^---/)
    expect(md).toContain('id: ISSUE--MY-FIRST-ISSUE')
    expect(md).toContain('priority: high')
    expect(md).toContain('# ISSUE — My first issue')
    expect(md).toContain('## Discussion')
  })

  it('create() auto-disambiguates on id collision', async () => {
    const store = new IssueStore({ root })
    const a = await store.create({ title: 'Same title' })
    const b = await store.create({ title: 'Same title' })
    expect(a.id).toBe('ISSUE--SAME-TITLE')
    expect(b.id).not.toBe(a.id)
    expect(b.id.startsWith('ISSUE--SAME-TITLE-')).toBe(true)
  })

  it('list() returns active issues by default (excludes closed/wontfix)', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'A — open' })
    await store.create({ title: 'B — closed' })
    await store.setStatus('ISSUE--B-CLOSED', 'closed', 'tester')
    await store.create({ title: 'C — wontfix' })
    await store.setStatus('ISSUE--C-WONTFIX', 'wontfix', 'tester')

    const active = await store.list()
    expect(active.map((i) => i.id)).toEqual(['ISSUE--A-OPEN'])

    const all = await store.list({ status: 'all' })
    expect(all.map((i) => i.id).sort()).toEqual([
      'ISSUE--A-OPEN',
      'ISSUE--B-CLOSED',
      'ISSUE--C-WONTFIX',
    ])
  })

  it('list() filters by priority / assignee / label', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'X', priority: 'high', labels: ['bug'] })
    await store.create({ title: 'Y', priority: 'low', labels: ['perf'], assignee: 'MSP-AGT-A' })
    await store.create({ title: 'Z', priority: 'high', labels: ['perf'], assignee: 'MSP-AGT-B' })

    expect((await store.list({ priority: 'high' })).map((i) => i.id).sort()).toEqual([
      'ISSUE--X',
      'ISSUE--Z',
    ])
    expect((await store.list({ label: 'perf' })).map((i) => i.id).sort()).toEqual([
      'ISSUE--Y',
      'ISSUE--Z',
    ])
    expect((await store.list({ assignee: 'MSP-AGT-A' })).map((i) => i.id)).toEqual(['ISSUE--Y'])
  })

  it('comment() appends to Discussion preserving history', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'Comment test' })
    await store.comment('ISSUE--COMMENT-TEST', 'first comment', 'MSP-USR-A')
    await store.comment('ISSUE--COMMENT-TEST', 'second comment', 'MSP-USR-B')

    const { body } = await store.show('ISSUE--COMMENT-TEST')
    expect(body).toMatch(/\[MSP-USR-A\] comment\n\nfirst comment/)
    expect(body).toMatch(/\[MSP-USR-B\] comment\n\nsecond comment/)
    // Order: first must precede second
    expect(body.indexOf('first comment')).toBeLessThan(body.indexOf('second comment'))
  })

  it('setStatus() validates the new status against the enum', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'Status test' })
    await expect(
      store.setStatus('ISSUE--STATUS-TEST', 'banana' as never, 'tester'),
    ).rejects.toThrow(/invalid status/)
  })

  it('setStatus() is a no-op when the status is already the target', async () => {
    const store = new IssueStore({ root })
    const before = await store.create({ title: 'Idempotent' })
    const after = await store.setStatus('ISSUE--IDEMPOTENT', 'open', 'tester')
    expect(after.updated_at).toBe(before.updated_at)
  })

  it('setStatus() to closed/wontfix sets closed_at', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'Close test' })
    const closed = await store.setStatus('ISSUE--CLOSE-TEST', 'closed', 'tester')
    expect(closed.closed_at).toBeTruthy()
    expect(closed.status).toBe('closed')
  })

  it('assign() updates the assignee and logs in Discussion', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'Assign test' })
    const after = await store.assign('ISSUE--ASSIGN-TEST', 'MSP-AGT-Z', 'tester')
    expect(after.assignee).toBe('MSP-AGT-Z')
    const { body } = await store.show('ISSUE--ASSIGN-TEST')
    expect(body).toMatch(/assignee: \(none\) → MSP-AGT-Z/)
  })

  it('close() with --resolved-by appends to crosslinks.resolved_by', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'Resolution test' })
    const after = await store.close('ISSUE--RESOLUTION-TEST', 'tester', 'ADR--CIRCUIT-BREAKER')
    expect(after.status).toBe('closed')
    expect(after.crosslinks?.resolved_by).toContain('ADR--CIRCUIT-BREAKER')
  })

  it('show() throws ENOENT-shaped error for unknown id', async () => {
    const store = new IssueStore({ root })
    await expect(store.show('ISSUE--DOES-NOT-EXIST')).rejects.toThrow(/not found/)
  })

  it('list() returns [] when issues dir does not exist', async () => {
    const store = new IssueStore({ root })
    expect(await store.list({ status: 'all' })).toEqual([])
  })

  it('round-trips all status values without parse errors', async () => {
    const store = new IssueStore({ root })
    await store.create({ title: 'Lifecycle test' })
    for (const s of ISSUE_STATUSES.filter((s) => s !== 'open')) {
      await store.setStatus('ISSUE--LIFECYCLE-TEST', s, 'tester')
      const { issue } = await store.show('ISSUE--LIFECYCLE-TEST')
      expect(issue.status).toBe(s)
    }
  })
})
