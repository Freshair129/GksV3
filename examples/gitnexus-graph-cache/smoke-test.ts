/**
 * End-to-end smoke test for the GitNexus → GKS GraphBackend cache
 * pattern. Spawns sync.ts and query-cached.ts via tsx and asserts the
 * round-trip works. Run from repo root:
 *
 *   tsx examples/gitnexus-graph-cache/smoke-test.ts
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'gn-cache-'))
const graphFile = join(tmp, 'code.jsonl')

function run(script: string, args: string[]): { stdout: string; code: number } {
  const r = spawnSync('npx', ['tsx', `examples/gitnexus-graph-cache/${script}`, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GKS_LOG_LEVEL: 'error' },
  })
  return { stdout: r.stdout ?? '', code: r.status ?? 0 }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`)
    process.exit(1)
  }
  console.log(`✓ ${msg}`)
}

try {
  // 1. Sync
  const sync = run('sync.ts', [`--graph=${graphFile}`])
  assert(sync.code === 0, 'sync exits 0')
  assert(/7 nodes \/ 5 edges/.test(sync.stdout), 'sync reports 7 nodes / 5 edges')

  // 2. Outbound walk: retain() → ... → yamlLite
  const out = run('query-cached.ts', [
    `--graph=${graphFile}`,
    '--seed=fn:src/memory/api.ts:retain',
    '--depth=3',
  ])
  assert(out.code === 0, 'outbound query exits 0')
  assert(/yamlLite/.test(out.stdout), 'outbound walk reaches yamlLite at depth 3')

  // 3. Inbound walk: yamlLite ← ... ← retain
  const inb = run('query-cached.ts', [
    `--graph=${graphFile}`,
    '--seed=fn:src/lib/yaml-lite.ts:yamlLite',
    '--depth=3',
    '--direction=in',
  ])
  assert(inb.code === 0, 'inbound query exits 0')
  assert(/retain/.test(inb.stdout), 'inbound walk traces back to retain')

  // 4. Re-sync is idempotent (supersede=true on edges)
  const resync = run('sync.ts', [`--graph=${graphFile}`])
  assert(resync.code === 0, 'idempotent re-sync exits 0')

  console.log('\nAll smoke checks passed.')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
