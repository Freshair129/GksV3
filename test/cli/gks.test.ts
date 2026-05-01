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
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(args: string[], cwd = process.cwd()): { stdout: string; stderr: string; code: number } {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const result = spawnSync(cmd, ['tsx', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    shell: true,
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

  it('lookup-by-symbol returns atoms whose linked_symbols cite the path', async () => {
    run(['init', `--root=${workdir}`])
    // Seed a hand-crafted atomic index (orchestrator/MSP normally does this
    // via the re-indexer; the CLI is paradigm-agnostic about how it got here).
    const fs = await import('node:fs/promises')
    const indexDir = join(workdir, 'gks', '00_index')
    await fs.mkdir(indexDir, { recursive: true })
    const rows = [
      {
        id: 'ADR--PARSE-TRACE-NORM',
        phase: 2,
        type: 'adr',
        status: 'stable',
        vault_id: 'V',
        path: 'concept/adr-parse-trace-norm.md',
        title: 'Parse-trace normalization',
        linked_symbols: [{ file: 'src/memory/consolidator-llm.ts', fn: 'formatStep' }],
      },
      {
        id: 'BLUEPRINT--FEAT-STOCK',
        phase: 3,
        type: 'blueprint',
        status: 'stable',
        vault_id: 'V',
        path: 'blueprint/feat-stock.yaml',
        title: 'Stock blueprint',
        geography: ['src/stock/fefo.ts:applyFefo'],
      },
    ]
    await fs.writeFile(
      join(indexDir, 'atomic_index.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    )

    const hit = run([
      'lookup-by-symbol',
      'src/memory/consolidator-llm.ts:formatStep',
      `--root=${workdir}`,
      '--json',
    ])
    expect(hit.code).toBe(0)
    const parsed = JSON.parse(hit.stdout) as { hit_count: number; hits: Array<{ id: string }> }
    expect(parsed.hit_count).toBe(1)
    expect(parsed.hits[0]!.id).toBe('ADR--PARSE-TRACE-NORM')

    const bp = run([
      'lookup-by-symbol',
      'src/stock/fefo.ts:applyFefo',
      `--root=${workdir}`,
      '--json',
    ])
    expect(bp.code).toBe(0)
    const bpParsed = JSON.parse(bp.stdout) as { hits: Array<{ id: string }> }
    expect(bpParsed.hits[0]!.id).toBe('BLUEPRINT--FEAT-STOCK')

    const miss = run([
      'lookup-by-symbol',
      'src/never.ts:nope',
      `--root=${workdir}`,
      '--json',
    ])
    expect(miss.code).toBe(0)
    const missParsed = JSON.parse(miss.stdout) as { hit_count: number }
    expect(missParsed.hit_count).toBe(0)
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

  it('community summarize walks crosslinks and prints synthesis', async () => {
    run(['init', `--root=${workdir}`])
    // Build a minimal 3-atom chain: CONCEPT → ADR (parent_concept) → FEAT (parent_adr)
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const gksDir = path.join(workdir, 'gks')
    for (const sub of ['concept', 'adr', 'feat', '00_index']) {
      await fs.mkdir(path.join(gksDir, sub), { recursive: true })
    }
    await fs.writeFile(
      path.join(gksDir, 'concept', 'CONCEPT--CLI-DEMO.md'),
      [
        '---',
        'id: CONCEPT--CLI-DEMO',
        'phase: 1',
        'type: concept',
        'status: stable',
        'vault_id: default',
        'title: CLI demo concept',
        'summary_tldr: Concept tldr line.',
        '---',
        '',
        '# CLI demo concept',
        '',
        'Body.',
        '',
      ].join('\n'),
      'utf8',
    )
    await fs.writeFile(
      path.join(gksDir, 'adr', 'ADR--CLI-DEMO.md'),
      [
        '---',
        'id: ADR--CLI-DEMO',
        'phase: 2',
        'type: adr',
        'status: stable',
        'vault_id: default',
        'title: CLI demo ADR',
        'summary_tldr: ADR tldr line.',
        'crosslinks: {"parent_concept":["CONCEPT--CLI-DEMO"]}',
        '---',
        '',
        '# CLI demo ADR',
        '',
        'Body.',
        '',
      ].join('\n'),
      'utf8',
    )
    await fs.writeFile(
      path.join(gksDir, 'feat', 'FEAT--CLI-DEMO.md'),
      [
        '---',
        'id: FEAT--CLI-DEMO',
        'phase: 2',
        'type: feat',
        'status: stable',
        'vault_id: default',
        'title: CLI demo feat',
        'summary_tldr: Feature tldr line.',
        'crosslinks: {"parent_adr":["ADR--CLI-DEMO"]}',
        '---',
        '',
        '# CLI demo feat',
        '',
        'Body.',
        '',
      ].join('\n'),
      'utf8',
    )
    // Index it.
    const indexer = resolve(__dirname, '..', '..', 'scripts', 'msp', 're-indexer.ts')
    const idx = spawnSync(NPX, ['tsx', indexer, `--root=${workdir}`], {
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, GKS_LOG_LEVEL: 'error' },
    })
    expect(idx.status).toBe(0)

    // Walk the chain.
    const r = run([
      'community',
      'summarize',
      'FEAT--CLI-DEMO',
      `--root=${workdir}`,
      '--hops=2',
      '--edges=parent_adr,parent_concept',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('community summary')
    expect(r.stdout).toContain('CONCEPT--CLI-DEMO')
    expect(r.stdout).toContain('ADR--CLI-DEMO')
    expect(r.stdout).toContain('FEAT--CLI-DEMO')
    expect(r.stdout).toContain('synthesis')

    // --json gives a machine-readable result.
    const j = run([
      'community',
      'summarize',
      'FEAT--CLI-DEMO',
      `--root=${workdir}`,
      '--hops=2',
      '--edges=parent_adr,parent_concept',
      '--json',
    ])
    expect(j.code).toBe(0)
    const parsed = JSON.parse(j.stdout) as {
      members: string[]
      summary: string
      generator: string
    }
    expect(parsed.members).toContain('FEAT--CLI-DEMO')
    expect(parsed.members).toContain('ADR--CLI-DEMO')
    expect(parsed.members).toContain('CONCEPT--CLI-DEMO')
    expect(parsed.generator).toBe('heuristic')
    expect(parsed.summary.length).toBeGreaterThan(0)
  }, 30_000)

  it('community summarize errors out without a seed', async () => {
    run(['init', `--root=${workdir}`])
    const r = run(['community', 'summarize', `--root=${workdir}`])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/at least one atomic id/)
  })
})
