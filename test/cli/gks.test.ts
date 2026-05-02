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

  it('episodic list / show / migrate round-trip via CLI', async () => {
    run(['init', `--root=${workdir}`])

    // Programmatically write a v2 session (mirrors what endSession does).
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const v2Dir = path.join(workdir, '.brain/msp/projects/evaAI/memory/SESS-CLI-001')
    await fs.mkdir(v2Dir, { recursive: true })
    await fs.writeFile(
      path.join(v2Dir, 'session.json'),
      JSON.stringify(
        {
          schema_version: '2.0.0',
          system: 'gks-v3',
          session_id: 'SESS-CLI-001',
          started_at: '2026-05-01T10:00:00Z',
          ended_at: '2026-05-01T10:30:00Z',
          summary: 'CLI smoke session',
        },
        null,
        2,
      ),
      'utf8',
    )
    await fs.writeFile(
      path.join(v2Dir, 'episodes.jsonl'),
      JSON.stringify({
        episode_id: 'E1',
        episode_type: 'interaction',
        turn_count: 2,
        first_turn_id: 'T1',
        last_turn_id: 'T2',
      }) + '\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(v2Dir, 'turns.jsonl'),
      [
        JSON.stringify({ turn_id: 'T1', episode_id: 'E1', t: '2026-05-01T10:00:00Z', speaker: 'user', raw_text: 'hello' }),
        JSON.stringify({ turn_id: 'T2', episode_id: 'E1', t: '2026-05-01T10:00:05Z', speaker: 'agent', raw_text: 'hi' }),
      ].join('\n') + '\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(workdir, '.brain/msp/projects/evaAI/memory/_index.jsonl'),
      JSON.stringify({
        session_id: 'SESS-CLI-001',
        schema_version: '2.0.0',
        started_at: '2026-05-01T10:00:00Z',
        ended_at: '2026-05-01T10:30:00Z',
        episode_count: 1,
        turn_count: 2,
        summary: 'CLI smoke session',
      }) + '\n',
      'utf8',
    )

    // list
    const list = run(['episodic', 'list', `--root=${workdir}`])
    expect(list.code).toBe(0)
    expect(list.stdout).toContain('SESS-CLI-001')
    expect(list.stdout).toMatch(/episodes=1/)

    // show (no --full → no turns)
    const show = run(['episodic', 'show', 'SESS-CLI-001', `--root=${workdir}`])
    expect(show.code).toBe(0)
    expect(show.stdout).toContain('SESS-CLI-001')
    expect(show.stdout).toMatch(/episodes:\s+1/)
    expect(show.stdout).toContain('CLI smoke session')

    // show --full → includes turns
    const showFull = run(['episodic', 'show', 'SESS-CLI-001', '--full', `--root=${workdir}`])
    expect(showFull.code).toBe(0)
    expect(showFull.stdout).toContain('T1')
    expect(showFull.stdout).toContain('hello')

    // show on nonexistent
    const missing = run(['episodic', 'show', 'NOT-A-SESSION', `--root=${workdir}`])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toMatch(/no v2 session/)
  }, 30_000)

  it('episodic migrate moves a v1 markdown session into v2 layout', async () => {
    run(['init', `--root=${workdir}`])
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    // Write a v1 markdown + matching trace.
    const memDir = path.join(workdir, '.brain/msp/projects/evaAI/memory')
    const sessionDir = path.join(workdir, '.brain/msp/projects/evaAI/session')
    await fs.mkdir(memDir, { recursive: true })
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(
      path.join(memDir, 'V1-SESS.md'),
      '---\nid: V1-SESS\nsession_id: V1-SESS\nstarted_at: "2026-05-01T09:00:00Z"\nended_at: "2026-05-01T09:30:00Z"\n---\n\n# V1 session body\n\nLegacy markdown.\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(sessionDir, 'V1-SESS.trace.jsonl'),
      [
        JSON.stringify({ t: '2026-05-01T09:00:00Z', session_id: 'V1-SESS', kind: 'user', content: 'q' }),
        JSON.stringify({ t: '2026-05-01T09:00:05Z', session_id: 'V1-SESS', kind: 'agent', content: 'a' }),
      ].join('\n') + '\n',
      'utf8',
    )

    const r = run(['episodic', 'migrate', 'V1-SESS', `--root=${workdir}`])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('V1-SESS')
    expect(r.stdout).toMatch(/v2 episode:/)

    // v2 file exists and carries 2 turns
    const v2sessionJson = path.join(memDir, 'V1-SESS', 'session.json')
    const v2Text = await fs.readFile(v2sessionJson, 'utf8')
    expect(v2Text).toContain('"schema_version": "2.0.0"')
    const turnsText = await fs.readFile(path.join(memDir, 'V1-SESS', 'turns.jsonl'), 'utf8')
    expect(turnsText.split('\n').filter((l) => l.length > 0)).toHaveLength(2)

    // Re-running without --force is refused
    const again = run(['episodic', 'migrate', 'V1-SESS', `--root=${workdir}`])
    expect(again.code).toBe(1)
    expect(again.stderr).toMatch(/already exists/)
  }, 30_000)
})
