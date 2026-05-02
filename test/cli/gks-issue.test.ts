/**
 * `gks issue *` CLI integration tests — spawns the CLI as a subprocess
 * and exercises the full lifecycle: new → comment → status → assign →
 * close, plus list filters and dashboard rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CLI = resolve(__dirname, '..', '..', 'bin', 'gks.ts')
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const r = spawnSync(cmd, ['tsx', CLI, ...args], {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, GKS_EMBEDDER: 'mock', GKS_LOG_LEVEL: 'error' },
  })
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? 0,
  }
}

describe('gks issue CLI', () => {
  let workdir = ''
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'gks-issue-cli-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('issue new creates a file and prints id + path', async () => {
    const r = run([
      'issue', 'new', 'CLI smoke test',
      `--root=${workdir}`,
      '--priority=high',
      '--label=bug',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/ISSUE--CLI-SMOKE-TEST/)
    expect(r.stdout).toMatch(/\[open\/high\]/)

    const md = await readFile(
      join(workdir, 'gks/issues/ISSUE--CLI-SMOKE-TEST.md'),
      'utf8',
    )
    expect(md).toContain('id: ISSUE--CLI-SMOKE-TEST')
    expect(md).toContain('priority: high')
    expect(md).toContain('labels:')
  }, 30_000)

  it('issue list shows active issues, filtered output', async () => {
    run(['issue', 'new', 'A — open', `--root=${workdir}`, '--priority=high'])
    run(['issue', 'new', 'B — done', `--root=${workdir}`])
    run(['issue', 'status', 'ISSUE--B-DONE', 'closed', `--root=${workdir}`])

    const active = run(['issue', 'list', `--root=${workdir}`])
    expect(active.code).toBe(0)
    expect(active.stdout).toMatch(/ISSUE--A-OPEN/)
    expect(active.stdout).not.toMatch(/ISSUE--B-DONE/)

    const all = run(['issue', 'list', '--status=all', `--root=${workdir}`])
    expect(all.stdout).toMatch(/ISSUE--A-OPEN/)
    expect(all.stdout).toMatch(/ISSUE--B-DONE/)
  }, 30_000)

  it('issue comment + show round-trips Discussion', async () => {
    run(['issue', 'new', 'Round trip', `--root=${workdir}`])
    const c = run([
      'issue', 'comment', 'ISSUE--ROUND-TRIP', 'reproduction confirmed',
      `--root=${workdir}`,
    ])
    expect(c.code).toBe(0)
    const show = run(['issue', 'show', 'ISSUE--ROUND-TRIP', `--root=${workdir}`])
    expect(show.stdout).toMatch(/reproduction confirmed/)
  }, 30_000)

  it('issue status changes status + appends Discussion log', async () => {
    run(['issue', 'new', 'Lifecycle', `--root=${workdir}`])
    const s = run([
      'issue', 'status', 'ISSUE--LIFECYCLE', 'in_progress',
      `--root=${workdir}`,
    ])
    expect(s.code).toBe(0)
    expect(s.stdout).toMatch(/in_progress/)
    const show = run(['issue', 'show', 'ISSUE--LIFECYCLE', `--root=${workdir}`])
    expect(show.stdout).toMatch(/status:\s+in_progress/)
    expect(show.stdout).toMatch(/status: open → in_progress/)
  }, 30_000)

  it('issue status rejects an invalid status name', async () => {
    run(['issue', 'new', 'Bad status', `--root=${workdir}`])
    const s = run([
      'issue', 'status', 'ISSUE--BAD-STATUS', 'banana',
      `--root=${workdir}`,
    ])
    expect(s.code).not.toBe(0)
    expect(s.stderr + s.stdout).toMatch(/invalid status/)
  }, 30_000)

  it('issue assign + close --resolved-by lifecycle', async () => {
    run(['issue', 'new', 'Resolution flow', `--root=${workdir}`])
    const a = run([
      'issue', 'assign', 'ISSUE--RESOLUTION-FLOW', 'MSP-AGT-Z',
      `--root=${workdir}`,
    ])
    expect(a.code).toBe(0)
    const c = run([
      'issue', 'close', 'ISSUE--RESOLUTION-FLOW',
      '--resolved-by=ADR--CIRCUIT-BREAKER',
      `--root=${workdir}`,
    ])
    expect(c.code).toBe(0)
    expect(c.stdout).toMatch(/closed.*ADR--CIRCUIT-BREAKER/)

    const md = await readFile(
      join(workdir, 'gks/issues/ISSUE--RESOLUTION-FLOW.md'),
      'utf8',
    )
    expect(md).toContain('status: closed')
    expect(md).toContain('ADR--CIRCUIT-BREAKER')
  }, 30_000)

  it('issue dashboard counts by status', async () => {
    run(['issue', 'new', 'A', `--root=${workdir}`])
    run(['issue', 'new', 'B', `--root=${workdir}`])
    run(['issue', 'status', 'ISSUE--B', 'closed', `--root=${workdir}`])
    const d = run(['issue', 'dashboard', `--root=${workdir}`])
    expect(d.code).toBe(0)
    expect(d.stdout).toMatch(/Issue dashboard — 2 total/)
    expect(d.stdout).toMatch(/open\s+1/)
    expect(d.stdout).toMatch(/closed\s+1/)
  }, 30_000)

  it('issue dashboard --md emits markdown table', async () => {
    run(['issue', 'new', 'Single', `--root=${workdir}`])
    const d = run(['issue', 'dashboard', '--md', `--root=${workdir}`])
    expect(d.code).toBe(0)
    expect(d.stdout).toMatch(/^# Issue dashboard/m)
    expect(d.stdout).toMatch(/\| Status \| Count \|/)
    expect(d.stdout).toMatch(/\| open \| 1 \|/)
  }, 30_000)

  it('issue list --json emits parseable JSON', async () => {
    run(['issue', 'new', 'JSON test', `--root=${workdir}`])
    const j = run(['issue', 'list', '--json', `--root=${workdir}`])
    expect(j.code).toBe(0)
    const parsed = JSON.parse(j.stdout) as {
      count: number
      issues: Array<{ id: string; status: string }>
    }
    expect(parsed.count).toBe(1)
    expect(parsed.issues[0]!.id).toBe('ISSUE--JSON-TEST')
  }, 30_000)
})
