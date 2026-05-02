/**
 * Re-indexer integration tests — invoke scripts/msp/re-indexer.ts as a
 * subprocess, run it against a hand-crafted gks/ tree in a tmpdir, then
 * verify the resulting atomic_index.jsonl + that AtomicLayer +
 * lookupBySymbol consume it correctly end-to-end.
 *
 * The subprocess approach mirrors test/cli/gks.test.ts — we want to
 * exercise the actual entry point, including arg parsing and exit
 * codes, not just the inner functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { AtomicLayer } from '../../src/memory/gks.js'

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'msp', 're-indexer.ts')
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const r = spawnSync(cmd, ['tsx', SCRIPT, ...args], {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, GKS_LOG_LEVEL: 'error' },
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 0 }
}

async function writeAtom(root: string, relPath: string, frontmatter: string, body = ''): Promise<void> {
  const full = join(root, 'gks', relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
}

async function readIndex(root: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(root, 'gks', '00_index', 'atomic_index.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('re-indexer (npm run msp:index)', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-reindex-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('walks gks/**/*.md, parses frontmatter, writes a deterministic JSONL', async () => {
    await writeAtom(
      root,
      'concept/eva.md',
      [
        'id: CONCEPT--EVA',
        'phase: 1',
        'type: concept',
        'status: stable',
        'vault_id: V',
        'title: EVA',
        'tags: [a, b]',
      ].join('\n'),
    )
    await writeAtom(
      root,
      'adr/foo.md',
      [
        'id: ADR--FOO',
        'phase: 2',
        'type: adr',
        'status: draft',
        'vault_id: V',
      ].join('\n'),
    )

    const r = run([`--root=${root}`])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/indexed:\s+2/)

    const rows = await readIndex(root)
    // Sorted by id alphabetically (deterministic output for diff-friendly).
    expect(rows.map((r) => r['id'])).toEqual(['ADR--FOO', 'CONCEPT--EVA'])
    expect((rows[0]!['path'] as string).replace(/\\/g, '/')).toBe('adr/foo.md')
    expect(rows[1]!['title']).toBe('EVA')
    expect(rows[1]!['tags']).toEqual(['a', 'b'])
  }, 30_000)

  it('preserves linked_symbols + geography for ADR-010 reverse lookup', async () => {
    await writeAtom(
      root,
      'adr/parse-trace.md',
      [
        'id: ADR--PARSE-TRACE-NORM',
        'phase: 2',
        'type: adr',
        'status: stable',
        'vault_id: V',
        'linked_symbols:',
        '  - { file: "src/x.ts", fn: foo, line: 42 }',
        '  - { file: "src/y.ts", fn: bar }',
      ].join('\n'),
    )
    await writeAtom(
      root,
      'blueprint/feat-stock.md',
      [
        'id: BLUEPRINT--FEAT-STOCK',
        'phase: 3',
        'type: blueprint',
        'status: stable',
        'vault_id: V',
        'geography:',
        '  - src/stock/fefo.ts:applyFefo',
        '  - src/stock/checkout.ts',
      ].join('\n'),
    )

    expect(run([`--root=${root}`]).code).toBe(0)

    const rows = await readIndex(root)
    const adr = rows.find((r) => r['id'] === 'ADR--PARSE-TRACE-NORM')!
    const bp = rows.find((r) => r['id'] === 'BLUEPRINT--FEAT-STOCK')!

    expect(adr['linked_symbols']).toEqual([
      { file: 'src/x.ts', fn: 'foo', line: 42 },
      { file: 'src/y.ts', fn: 'bar' },
    ])
    expect(bp['geography']).toEqual(['src/stock/fefo.ts:applyFefo', 'src/stock/checkout.ts'])

    // End-to-end with the AtomicLayer reverse query — the index this
    // script just produced should be lookupBySymbol-ready.
    const layer = new AtomicLayer({
      indexPath: join(root, 'gks', '00_index', 'atomic_index.jsonl'),
      gksRoot: join(root, 'gks'),
    })
    await layer.loadIndex()
    expect(layer.searchBySymbol('src/x.ts:foo').map((e) => e.id)).toEqual([
      'ADR--PARSE-TRACE-NORM',
    ])
    expect(layer.searchBySymbol('src/stock/fefo.ts:applyFefo').map((e) => e.id)).toEqual([
      'BLUEPRINT--FEAT-STOCK',
    ])
  }, 30_000)

  it('skips files without an id field + reports counts', async () => {
    await writeAtom(
      root,
      'adr/no-id.md',
      ['type: adr', 'phase: 2'].join('\n'),
    )
    await writeAtom(
      root,
      'adr/bad-id.md',
      ['id: lowercase-bad', 'phase: 2', 'type: adr', 'status: draft', 'vault_id: V'].join('\n'),
    )
    await writeAtom(
      root,
      'adr/ok.md',
      ['id: ADR--OK', 'phase: 2', 'type: adr', 'status: draft', 'vault_id: V'].join('\n'),
    )

    const r = run([`--root=${root}`])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/indexed:\s+1/)
    expect(r.stdout).toMatch(/skipped:\s+2/)

    const rows = await readIndex(root)
    expect(rows.map((r) => r['id'])).toEqual(['ADR--OK'])
  }, 30_000)

  it('--dry-run reports stats without writing the JSONL', async () => {
    await writeAtom(
      root,
      'concept/eva.md',
      ['id: CONCEPT--EVA', 'phase: 1', 'type: concept', 'status: stable', 'vault_id: V'].join('\n'),
    )

    const r = run([`--root=${root}`, '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/dry-run/)
    expect(r.stdout).toMatch(/indexed:\s+1/)

    // Index file should NOT exist.
    await expect(
      readFile(join(root, 'gks', '00_index', 'atomic_index.jsonl'), 'utf8'),
    ).rejects.toThrow(/ENOENT/)
  }, 30_000)

  it('skips the 00_index directory itself (no self-reference)', async () => {
    // Pre-existing index — re-indexer must not try to parse it as an atom.
    await mkdir(join(root, 'gks', '00_index'), { recursive: true })
    await writeFile(
      join(root, 'gks', '00_index', 'atomic_index.jsonl'),
      JSON.stringify({ id: 'STALE--ROW' }) + '\n',
    )
    await writeAtom(
      root,
      'concept/eva.md',
      ['id: CONCEPT--EVA', 'phase: 1', 'type: concept', 'status: stable', 'vault_id: V'].join('\n'),
    )

    const r = run([`--root=${root}`])
    expect(r.code).toBe(0)
    const rows = await readIndex(root)
    expect(rows.map((r) => r['id'])).toEqual(['CONCEPT--EVA'])
    // Stale entry blown away — no self-reference, no leftover.
    expect(rows.length).toBe(1)
  }, 30_000)
})
