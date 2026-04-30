/**
 * `gks poc *` CLI integration tests — spawns the CLI as a subprocess
 * and exercises the full lifecycle: open → start → close, plus list
 * filters, the overdue gate (`poc check`), and validation guards.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CLI = resolve(__dirname, '..', '..', 'bin', 'gks.ts')
const FUTURE_DEADLINE = '2099-01-01T00:00:00Z'
const PAST_DEADLINE = '2020-01-01T00:00:00Z'

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('npx', ['tsx', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GKS_EMBEDDER: 'mock', GKS_LOG_LEVEL: 'error' },
  })
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? 0,
  }
}

describe('gks poc CLI', () => {
  let workdir = ''
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'gks-poc-cli-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('poc open creates a file and prints id + deadline', async () => {
    const r = run([
      'poc', 'open', 'demo',
      `--root=${workdir}`,
      '--hypothesis=It works under condition Y',
      '--acceptance-criterion=metric M ≥ 0.8',
      `--deadline=${FUTURE_DEADLINE}`,
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('opened POC--DEMO')
    expect(r.stdout).toContain(`deadline: ${FUTURE_DEADLINE}`)
    const text = await readFile(join(workdir, 'gks', 'poc', 'POC--DEMO.md'), 'utf8')
    expect(text).toContain('id: POC--DEMO')
    expect(text).toContain('status: open')
    expect(text).toContain('hypothesis:')
  })

  it('poc open requires --hypothesis, --acceptance-criterion, --deadline', async () => {
    const noHypothesis = run([
      'poc', 'open', 'demo',
      `--root=${workdir}`,
      '--acceptance-criterion=c',
      `--deadline=${FUTURE_DEADLINE}`,
    ])
    expect(noHypothesis.code).toBe(1)
    expect(noHypothesis.stderr).toContain('--hypothesis')

    const noCriterion = run([
      'poc', 'open', 'demo',
      `--root=${workdir}`,
      '--hypothesis=h',
      `--deadline=${FUTURE_DEADLINE}`,
    ])
    expect(noCriterion.code).toBe(1)
    expect(noCriterion.stderr).toContain('acceptance-criterion')

    const noDeadline = run([
      'poc', 'open', 'demo',
      `--root=${workdir}`,
      '--hypothesis=h',
      '--acceptance-criterion=c',
    ])
    expect(noDeadline.code).toBe(1)
    expect(noDeadline.stderr).toContain('--deadline')
  })

  it('poc start transitions open → running', async () => {
    run([
      'poc', 'open', 'demo',
      `--root=${workdir}`,
      '--hypothesis=h',
      '--acceptance-criterion=c',
      `--deadline=${FUTURE_DEADLINE}`,
    ])
    const r = run(['poc', 'start', 'POC--DEMO', `--root=${workdir}`])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('started POC--DEMO')
    expect(r.stdout).toContain('status=running')
  })

  it('poc close requires a valid --resolution and records crosslinks', async () => {
    run([
      'poc', 'open', 'demo',
      `--root=${workdir}`,
      '--hypothesis=h',
      '--acceptance-criterion=c',
      `--deadline=${FUTURE_DEADLINE}`,
    ])

    const badRes = run(['poc', 'close', 'POC--DEMO', `--root=${workdir}`, '--resolution=stable'])
    expect(badRes.code).toBe(1)
    expect(badRes.stderr).toContain('validated | invalidated | abandoned')

    const ok = run([
      'poc', 'close', 'POC--DEMO',
      `--root=${workdir}`,
      '--resolution=validated',
      '--feeds-into=ADR--DEMO-DECIDED',
    ])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('resolution=validated')
    const text = await readFile(join(workdir, 'gks', 'poc', 'POC--DEMO.md'), 'utf8')
    expect(text).toContain('status: validated')
    expect(text).toContain('ADR--DEMO-DECIDED')
  })

  it('poc list shows opened atom; --open filters out closed', async () => {
    run([
      'poc', 'open', 'first',
      `--root=${workdir}`,
      '--hypothesis=h',
      '--acceptance-criterion=c',
      `--deadline=${FUTURE_DEADLINE}`,
    ])
    run([
      'poc', 'open', 'second',
      `--root=${workdir}`,
      '--hypothesis=h',
      '--acceptance-criterion=c',
      `--deadline=${FUTURE_DEADLINE}`,
    ])
    run(['poc', 'close', 'POC--FIRST', `--root=${workdir}`, '--resolution=abandoned'])

    const all = run(['poc', 'list', `--root=${workdir}`])
    expect(all.stdout).toContain('POC--FIRST')
    expect(all.stdout).toContain('POC--SECOND')

    const open = run(['poc', 'list', '--open', `--root=${workdir}`])
    expect(open.stdout).not.toContain('POC--FIRST')
    expect(open.stdout).toContain('POC--SECOND')
  })

  it('poc check exits 1 with diagnostic when an overdue POC touches --file', async () => {
    run([
      'poc', 'open', 'gate-demo',
      `--root=${workdir}`,
      '--hypothesis=h',
      '--acceptance-criterion=c',
      `--deadline=${FUTURE_DEADLINE}`,
      '--file=examples/gate-demo/run.ts',
    ])
    // Backdate deadline (yamlLite renders time_box as inline JSON).
    const path = join(workdir, 'gks', 'poc', 'POC--GATE-DEMO.md')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace(/"deadline":"[^"]+"/, `"deadline":"${PAST_DEADLINE}"`))

    const blocked = run([
      'poc', 'check',
      `--root=${workdir}`,
      '--file=examples/gate-demo/run.ts',
    ])
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain('poc gate: 1 overdue POC(s) block this commit')
    expect(blocked.stderr).toContain('POC--GATE-DEMO')

    // Different file → not blocking
    const clear = run(['poc', 'check', `--root=${workdir}`, '--file=other.ts'])
    expect(clear.code).toBe(0)
    expect(clear.stdout).toContain('poc gate: clear')
  })
})
