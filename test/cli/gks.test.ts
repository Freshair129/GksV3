/**
 * `gks` CLI integration test — invokes bin/gks.ts via tsx subprocess and
 * asserts behavior end-to-end. Validates the subcommand contract that
 * D.2 ships.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CLI = resolve(__dirname, '..', '..', 'bin', 'gks.ts')

function run(args: string[], cwd = process.cwd()): { stdout: string; stderr: string; code: number } {
  const result = spawnSync('npx', ['tsx', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GKS_EMBEDDER: 'mock', GKS_LOG_LEVEL: 'error' },
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 0,
  }
}

describe('gks CLI', () => {
  let workdir = ''
  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'gks-cli-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('init creates the .brain directory tree', async () => {
    const r = run(['init', `--root=${workdir}`])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/initialised/)
  })

  it('retain → recall round-trip', async () => {
    run(['init', `--root=${workdir}`])
    const retainResult = run([
      'retain',
      'the cat sat on the mat',
      `--root=${workdir}`,
      '--path=cat.md',
    ])
    expect(retainResult.code).toBe(0)
    expect(retainResult.stdout).toMatch(/retained/)

    const recallResult = run([
      'recall',
      'the cat sat on the mat',
      `--root=${workdir}`,
      '--top-k=1',
      '--threshold=-1',
    ])
    expect(recallResult.code).toBe(0)
    expect(recallResult.stdout).toMatch(/cat/)
  }, 30_000)

  it('lookup returns non-zero for unknown id (plain output)', async () => {
    run(['init', `--root=${workdir}`])
    const r = run(['lookup', 'CONCEPT--DOES-NOT-EXIST', `--root=${workdir}`])
    expect(r.code).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/not found/)
  }, 30_000)

  it('lookup --json returns exit 0 with {found:false} on unknown id', async () => {
    run(['init', `--root=${workdir}`])
    const r = run(['lookup', 'CONCEPT--DOES-NOT-EXIST', `--root=${workdir}`, '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { found: boolean }
    expect(parsed.found).toBe(false)
  }, 30_000)

  it('propose-inbound writes an artifact', async () => {
    run(['init', `--root=${workdir}`])
    const r = run([
      'propose-inbound',
      'INSIGHT--CLI-TEST',
      `--root=${workdir}`,
      '--title=CLI works',
      '--body=Verified by integration test',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/INSIGHT--CLI-TEST/)
    expect(r.stdout).toMatch(/inbound/)
  }, 30_000)

  it('propose-inbound --linked-symbol records code references', async () => {
    run(['init', `--root=${workdir}`])
    const r = run([
      'propose-inbound',
      'ADR--LINKED-SYMBOL-CLI',
      `--root=${workdir}`,
      '--title=Linked symbols via CLI',
      '--body=Round-trip test',
      '--linked-symbol=src/memory/inbound.ts:renderArtifactMarkdown:77',
      '--linked-symbol=src/lib/yaml-lite.ts:yamlLite',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/linked_symbols: 2/)

    const inboundDir = join(workdir, '.brain/msp/projects/evaAI/inbound')
    const fs = await import('node:fs/promises')
    const files = await fs.readdir(inboundDir)
    const artifact = files.find((f) => f.startsWith('ADR--LINKED-SYMBOL-CLI'))
    expect(artifact).toBeTruthy()
    const md = await fs.readFile(join(inboundDir, artifact!), 'utf8')
    expect(md).toContain('linked_symbols:')
    expect(md).toContain('"file":"src/memory/inbound.ts"')
    expect(md).toContain('"fn":"renderArtifactMarkdown"')
    expect(md).toContain('"line":77')
    expect(md).toContain('"file":"src/lib/yaml-lite.ts"')
    expect(md).toContain('"fn":"yamlLite"')
  }, 30_000)

  it('--json emits machine-readable output', async () => {
    run(['init', `--root=${workdir}`])
    const r = run(['status', `--root=${workdir}`, '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { schema_version: string }
    expect(parsed.schema_version).toMatch(/^\d+\.\d+\.\d+$/)
  }, 30_000)

  it('prints usage on no args', async () => {
    const r = run([])
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/Subcommands/)
  })
})
