/**
 * End-to-end smoke test for the drift-detection example. Spawns
 * check-drift.ts via tsx and asserts:
 *
 *   • HIGH risk fires for a path cited by an ADR (exit 1)
 *   • MEDIUM risk fires for a path cited by a FEAT (exit 1)
 *   • LOW risk does NOT block (exit 0) but still surfaces the citation
 *   • NONE result + no citations also exits 0
 *   • --json output is parseable + reflects the same classification
 *   • stdin mode works (the pre-push-hook.sh path)
 *
 * Run from this directory:  tsx smoke-test.ts
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, 'check-drift.ts')
const ROOT = resolve(HERE, 'fixtures')
const GRAPH = resolve(HERE, 'fixtures', 'code-graph.jsonl')

interface Result {
  stdout: string
  stderr: string
  code: number
}

function run(args: string[], stdin?: string): Result {
  const r = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, GKS_LOG_LEVEL: 'error' },
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 0 }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`)
    process.exit(1)
  }
  console.log(`✓ ${msg}`)
}

// 1. ADR citation → HIGH → exit 1
{
  const r = run([`--root=${ROOT}`, `--graph=${GRAPH}`, '--paths=src/memory/consolidator-llm.ts:formatStep'])
  assert(r.code === 1, 'HIGH risk (ADR) → exit 1')
  assert(/HIGH\s+src\/memory\/consolidator-llm\.ts:formatStep/.test(r.stdout), 'HIGH path printed')
  assert(/ADR--PARSE-TRACE-NORM/.test(r.stdout), 'ADR id surfaced')
}

// 2. BLUEPRINT geography citation → HIGH (geography is treated like ADR)
{
  const r = run([`--root=${ROOT}`, `--graph=${GRAPH}`, '--paths=src/stock/fefo.ts:applyFefo'])
  assert(r.code === 1, 'BLUEPRINT geography → exit 1')
  assert(/BLUEPRINT--FEAT-STOCK/.test(r.stdout), 'BLUEPRINT id surfaced')
}

// 3. FEAT citation → MEDIUM → exit 1
{
  const r = run([`--root=${ROOT}`, `--graph=${GRAPH}`, '--paths=src/memory/inbound.ts:propose'])
  assert(r.code === 1, 'MEDIUM risk (FEAT) → exit 1')
  assert(/MEDIUM\s+src\/memory\/inbound\.ts:propose/.test(r.stdout), 'MEDIUM path printed')
  assert(/FEAT--INBOUND-QUEUE/.test(r.stdout), 'FEAT id surfaced')
}

// 4. INSIGHT citation → LOW → exit 0 (informative, not blocking)
{
  const r = run([`--root=${ROOT}`, `--graph=${GRAPH}`, '--paths=src/lib/yaml-lite.ts:yamlScalar'])
  assert(r.code === 0, 'LOW risk (INSIGHT) → exit 0 (not blocking)')
  assert(/LOW\s+src\/lib\/yaml-lite\.ts:yamlScalar/.test(r.stdout), 'LOW path printed')
  assert(/INSIGHT--YAML-LITE/.test(r.stdout), 'INSIGHT id surfaced')
  // Graph caller chain should be visible
  assert(/called by/.test(r.stdout), 'inbound callers from graph cache shown')
}

// 5. No citation → NONE → exit 0
{
  const r = run([`--root=${ROOT}`, `--graph=${GRAPH}`, '--paths=src/never.ts'])
  assert(r.code === 0, 'NONE → exit 0 (no citations)')
  assert(/NONE\s+src\/never\.ts/.test(r.stdout), 'NONE path printed')
  assert(/no doc\/code drift signals/.test(r.stdout), 'all-clear message')
}

// 6. JSON mode parses + carries the same classification
{
  const r = run([
    `--root=${ROOT}`,
    `--graph=${GRAPH}`,
    '--paths=src/memory/consolidator-llm.ts:formatStep,src/never.ts',
    '--json',
  ])
  assert(r.code === 1, 'mixed HIGH+NONE → exit 1')
  // The JSON object is the last block — strip the noisy log lines, then parse.
  const start = r.stdout.indexOf('{')
  const parsed = JSON.parse(r.stdout.slice(start)) as {
    summary: { high: number; medium: number; none: number }
    review_needed: boolean
  }
  assert(parsed.summary.high === 1, 'JSON summary.high == 1')
  assert(parsed.summary.none === 1, 'JSON summary.none == 1')
  assert(parsed.review_needed === true, 'JSON review_needed flag set')
}

// 7. stdin mode (the pre-push-hook code path)
{
  const r = run(
    [`--root=${ROOT}`, `--graph=${GRAPH}`, '--stdin'],
    'src/memory/consolidator-llm.ts:formatStep\nsrc/never.ts\n',
  )
  assert(r.code === 1, 'stdin mode HIGH+NONE → exit 1')
  assert(/HIGH/.test(r.stdout) && /NONE/.test(r.stdout), 'stdin mode reports both paths')
}

console.log('\nAll drift-detection smoke checks passed.')
