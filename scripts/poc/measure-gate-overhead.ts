/**
 * Synthetic measurement for POC--POC-OVERDUE-CI-INTEGRATION.
 *
 * Measures `gks poc check` overhead under three scenarios:
 *   1. Empty gks/poc/ — baseline
 *   2. Populated with future-deadline POCs only — no blocking
 *   3. One overdue POC — blocking path
 *
 * Records p50 / p95 / p99 across N invocations of the in-process
 * PocStore.listOverdue() — same code path the CLI uses, but without
 * subprocess startup cost (which is noise for the question we're
 * actually asking: "is the listOverdue scan fast?").
 *
 * Run:
 *   npx tsx scripts/poc/measure-gate-overhead.ts --iterations=200
 *
 * Output:
 *   { scenario, n, p50, p95, p99, mean, max }[]
 *
 * Acceptance criterion (POC--POC-OVERDUE-CI-INTEGRATION):
 *   - p95 < 500ms across all three scenarios at typical repo sizes (≤100 atoms)
 */

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { PocStore } from '../../src/poc/store.js'

interface Stats {
  scenario: string
  n: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  meanMs: number
  maxMs: number
}

function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.ceil(sortedAsc.length * p) - 1
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))] ?? 0
}

function describe(scenario: string, samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    scenario,
    n: samples.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    meanMs: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    maxMs: round(Math.max(...samples)),
  }
}

const round = (n: number): number => Math.round(n * 10) / 10

async function timeListOverdue(store: PocStore): Promise<number> {
  const t = process.hrtime.bigint()
  await store.listOverdue()
  return Number(process.hrtime.bigint() - t) / 1_000_000 // → ms
}

async function backdateOnePoc(root: string, id: string): Promise<void> {
  const path = join(root, 'gks', 'poc', `${id}.md`)
  const text = await readFile(path, 'utf8')
  await writeFile(
    path,
    text.replace(/"deadline":"[^"]+"/, `"deadline":"2020-01-01T00:00:00Z"`),
  )
}

async function runScenario(
  name: string,
  setup: (store: PocStore, root: string) => Promise<void>,
  iterations: number,
): Promise<Stats> {
  const root = await mkdtemp(join(tmpdir(), 'gks-poc-bench-'))
  try {
    const store = new PocStore({ root })
    await setup(store, root)

    // Warmup
    for (let i = 0; i < 5; i++) await store.listOverdue()

    const samples: number[] = []
    for (let i = 0; i < iterations; i++) {
      samples.push(await timeListOverdue(store))
    }
    return describe(name, samples)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      iterations: { type: 'string', default: '200' },
      'poc-count': { type: 'string', default: '50' },
      json: { type: 'boolean' },
    },
  })
  const iterations = Number(values['iterations'])
  const pocCount = Number(values['poc-count'])
  if (!Number.isFinite(iterations) || iterations < 10) {
    throw new Error(`iterations must be an integer >= 10 (got ${values['iterations']})`)
  }

  const futureDeadline = '2099-01-01T00:00:00Z'
  const results: Stats[] = []

  // Scenario 1: empty gks/poc/
  results.push(
    await runScenario('empty', async () => { /* no setup */ }, iterations),
  )

  // Scenario 2: populated with future-deadline POCs (no overdue)
  results.push(
    await runScenario(
      `${pocCount}-future`,
      async (store) => {
        for (let i = 0; i < pocCount; i++) {
          await store.open({
            slug: `future-${i}`,
            title: `Future POC ${i}`,
            hypothesis: `h${i}`,
            acceptanceCriteria: [`c${i}`],
            deadline: futureDeadline,
          })
        }
      },
      iterations,
    ),
  )

  // Scenario 3: one overdue (rest still future)
  results.push(
    await runScenario(
      `${pocCount}-with-1-overdue`,
      async (store, root) => {
        for (let i = 0; i < pocCount; i++) {
          await store.open({
            slug: `mixed-${i}`,
            title: `Mixed POC ${i}`,
            hypothesis: `h${i}`,
            acceptanceCriteria: [`c${i}`],
            deadline: futureDeadline,
          })
        }
        await backdateOnePoc(root, 'POC--MIXED-0')
      },
      iterations,
    ),
  )

  if (values['json']) {
    console.log(JSON.stringify({ iterations, pocCount, results }, null, 2))
    return
  }

  console.log(
    `\nGate overhead — ${iterations} iterations of PocStore.listOverdue()\n`,
  )
  console.log('Scenario                       n     p50      p95      p99      max     mean')
  console.log('---------------------------------------------------------------------------')
  for (const r of results) {
    console.log(
      `${r.scenario.padEnd(30)} ${String(r.n).padEnd(5)} ` +
        `${(r.p50Ms + 'ms').padEnd(8)} ${(r.p95Ms + 'ms').padEnd(8)} ` +
        `${(r.p99Ms + 'ms').padEnd(8)} ${(r.maxMs + 'ms').padEnd(7)} ${r.meanMs}ms`,
    )
  }

  console.log()
  const worstP95 = Math.max(...results.map((r) => r.p95Ms))
  const target = 500 // POC--POC-OVERDUE-CI-INTEGRATION acceptance criterion
  if (worstP95 < target) {
    console.log(`✓ acceptance criterion met: worst p95 ${worstP95}ms < ${target}ms target`)
  } else {
    console.log(`✗ acceptance criterion FAILED: worst p95 ${worstP95}ms ≥ ${target}ms target`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('measure-gate-overhead:', (err as Error).message)
  process.exit(1)
})
