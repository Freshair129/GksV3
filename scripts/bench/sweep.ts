#!/usr/bin/env tsx
/**
 * Benchmark sweep — runs LoCoMo / LongMemEval / BEAM across an
 * (embedder × reranker × backend) matrix and emits a single
 * provenance-stamped report (JSON + Markdown).
 *
 * Usage
 *   npm run bench:sweep -- --config=benchmarks/sweep.example.json
 *   npm run bench:sweep -- --benchmarks=locomo,beam --backends=hnsw,pgvector
 *
 * Each cell of the matrix invokes the corresponding runner as a child
 * process so that runs are fully isolated (independent workdirs, fresh
 * embedder cache, no cross-talk on the JSONL store).
 *
 * Output
 *   benchmarks/reports/sweep-<git-sha>-<timestamp>.json
 *   benchmarks/reports/sweep-<git-sha>-<timestamp>.md
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { fileExists, readJsonSafe } from '../../src/lib/jsonl.js'
import { isRecord } from '../../src/lib/guards.js'
import { round2 } from '../../benchmarks/_harness.js'
import { createLogger } from '../../src/lib/logger.js'

const log = createLogger('script:sweep')

type BenchmarkName = 'locomo' | 'longmemeval' | 'beam'
type BackendName = 'jsonl' | 'hnsw' | 'pgvector'
type Provider = 'auto' | 'ollama' | 'openai' | 'mock'

interface MatrixConfig {
  benchmarks: BenchmarkName[]
  backends: BackendName[]
  providers: Provider[]
  rerankers: Array<'lexical' | 'http' | 'off'>
  topK: number
  threshold: number
  /** Per-benchmark overrides (datasets, query-limit, etc.). */
  perBench?: Partial<Record<BenchmarkName, { datasetPath?: string; extraArgs?: string[] }>>
}

interface CellResult {
  benchmark: BenchmarkName
  backend: BackendName
  provider: Provider
  reranker: string
  ok: boolean
  durationMs: number
  report?: Record<string, unknown>
  error?: string
}

interface SweepReport {
  meta: {
    timestamp: string
    git: { sha: string; dirty: boolean }
    node: string
    platform: string
    config: MatrixConfig
  }
  totals: {
    cells: number
    passed: number
    failed: number
    duration_ms: number
  }
  results: CellResult[]
}

const DEFAULTS: MatrixConfig = {
  benchmarks: ['locomo', 'longmemeval', 'beam'],
  backends: ['jsonl', 'hnsw'], // pgvector requires DATABASE_URL — opt-in
  providers: ['mock'], // bump to ['ollama'] for SOTA runs
  rerankers: ['lexical'], // add 'http' when you have a TEI endpoint
  topK: 5,
  threshold: 0.2,
}

async function main(): Promise<void> {
  const opts = parseOptions()
  const config = await resolveConfig(opts.configPath, opts.overrides)

  log.info('sweep starting', {
    cells: cellCount(config),
    benchmarks: config.benchmarks,
    backends: config.backends,
    providers: config.providers,
    rerankers: config.rerankers,
  })

  const meta = await captureMeta(config)
  const cells = enumerate(config)

  const results: CellResult[] = []
  const startedAt = Date.now()

  for (const cell of cells) {
    log.info('running cell', { ...cell })
    results.push(await runCell(cell, config))
  }

  const report: SweepReport = {
    meta,
    totals: {
      cells: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      duration_ms: Date.now() - startedAt,
    },
    results,
  }

  await writeReports(report, opts.outputDir)
  console.log(formatMarkdown(report))

  if (report.totals.failed > 0 && process.env['SWEEP_STRICT'] === '1') {
    process.exit(3)
  }
}

interface CellSpec {
  benchmark: BenchmarkName
  backend: BackendName
  provider: Provider
  reranker: string
}

function enumerate(config: MatrixConfig): CellSpec[] {
  const out: CellSpec[] = []
  for (const benchmark of config.benchmarks) {
    for (const backend of config.backends) {
      for (const provider of config.providers) {
        for (const reranker of config.rerankers) {
          out.push({ benchmark, backend, provider, reranker })
        }
      }
    }
  }
  return out
}

function cellCount(c: MatrixConfig): number {
  return c.benchmarks.length * c.backends.length * c.providers.length * c.rerankers.length
}

async function runCell(cell: CellSpec, config: MatrixConfig): Promise<CellResult> {
  const start = Date.now()
  const args: string[] = [
    `--top-k=${config.topK}`,
    `--threshold=${config.threshold}`,
    `--backend=${cell.backend}`,
    `--provider=${cell.provider}`,
  ]

  // Reranker selection — runners read --rerank-endpoint for HTTP, otherwise
  // the existing lexical default applies. 'off' uses each runner's --reranker
  // flag (where supported).
  if (cell.reranker === 'http') {
    const endpoint = process.env['GKS_RERANK_ENDPOINT']
    if (!endpoint) {
      return {
        benchmark: cell.benchmark,
        backend: cell.backend,
        provider: cell.provider,
        reranker: cell.reranker,
        ok: false,
        durationMs: 0,
        error: 'rerank=http requires GKS_RERANK_ENDPOINT env var',
      }
    }
    args.push(`--rerank-endpoint=${endpoint}`)
  } else if (cell.reranker === 'off') {
    args.push('--reranker=off')
  }

  const perBench = config.perBench?.[cell.benchmark]
  if (perBench?.datasetPath) args.push(`--dataset=${perBench.datasetPath}`)
  if (perBench?.extraArgs) args.push(...perBench.extraArgs)

  // Workdir is the only thing that varies per cell (apart from the args). We
  // want a stable name so reruns reuse caches when --fresh isn't passed.
  const cellId = `${cell.benchmark}-${cell.backend}-${cell.provider}-${cell.reranker}`
  args.push(`--work-dir=./benchmarks/.cache/sweep/${cellId}`)

  const script = `benchmarks/${cell.benchmark}.ts`
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const result = await execAndCapture(npx, ['tsx', script, ...args], 600_000)

  return {
    benchmark: cell.benchmark,
    backend: cell.backend,
    provider: cell.provider,
    reranker: cell.reranker,
    ok: result.ok,
    durationMs: Date.now() - start,
    ...(result.report ? { report: result.report } : {}),
    ...(result.error ? { error: result.error } : {}),
  }
}

async function execAndCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; report?: Record<string, unknown>; error?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: process.env, shell: process.platform === 'win32' })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8')
    })
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8')
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolvePromise({
          ok: false,
          error: `exit ${code}; stderr tail: ${stderr.slice(-500)}`,
        })
        return
      }
      const parsed = extractReportJson(stdout)
      if (!parsed) {
        resolvePromise({
          ok: false,
          error: `no JSON report found in stdout (last 200 chars: ${stdout.slice(-200)})`,
        })
        return
      }
      resolvePromise({ ok: true, report: parsed })
    })
  })
}

/** Each runner prints a JSON object inside a horizontal-rule banner. Pull it. */
function extractReportJson(stdout: string): Record<string, unknown> | null {
  // The runners emit structured log lines before the final multi-line report.
  // Strategy: find the last '}' in stdout, then scan backwards to its matching
  // '{' (depth-counting, string-aware), then parse that block.
  let end = stdout.lastIndexOf('}')
  while (end !== -1) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = end; i >= 0; i--) {
      const ch = stdout[i]!
      if (!inString) {
        if (ch === '}') depth++
        else if (ch === '{') {
          depth--
          if (depth === 0) {
            try {
              const parsed = JSON.parse(stdout.slice(i, end + 1)) as Record<string, unknown>
              // Skip structured log lines (always have "level" + "msg").
              if ('level' in parsed && 'msg' in parsed) break
              return parsed
            } catch {
              break
            }
          }
        } else if (ch === '"') {
          // Entering a string — need to check for escape sequences going backwards
          // is complex; just trust the JSON.parse to catch malformed strings.
          inString = true
        }
      } else {
        if (ch === '"' && !escape) inString = false
        escape = ch === '\\'
      }
    }
    // Try the next-to-last '}'
    end = stdout.lastIndexOf('}', end - 1)
  }
  return null
}

async function captureMeta(config: MatrixConfig): Promise<SweepReport['meta']> {
  let sha = 'unknown'
  let dirty = false
  try {
    sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    dirty = status.trim().length > 0
  } catch {
    // not a git repo or git unavailable; leave defaults
  }
  return {
    timestamp: new Date().toISOString(),
    git: { sha, dirty },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    config,
  }
}

async function resolveConfig(
  configPath: string | undefined,
  overrides: Partial<MatrixConfig>,
): Promise<MatrixConfig> {
  let base: MatrixConfig = { ...DEFAULTS }
  if (configPath) {
    const txt = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(txt) as Partial<MatrixConfig>
    base = { ...base, ...parsed }
  }
  return { ...base, ...overrides }
}

async function writeReports(report: SweepReport, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const stem = `sweep-${report.meta.git.sha}${report.meta.git.dirty ? '-dirty' : ''}-${report.meta.timestamp.replace(/[:.]/g, '-')}`
  const jsonPath = join(dir, `${stem}.json`)
  const mdPath = join(dir, `${stem}.md`)
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  await writeFile(mdPath, formatMarkdown(report), 'utf8')
  log.info('reports written', { jsonPath, mdPath })
}

function formatMarkdown(report: SweepReport): string {
  const lines: string[] = []
  lines.push(`# GKS v3 — Benchmark Sweep`)
  lines.push('')
  lines.push(`- **Git:** \`${report.meta.git.sha}${report.meta.git.dirty ? ' (dirty)' : ''}\``)
  lines.push(`- **Timestamp:** ${report.meta.timestamp}`)
  lines.push(`- **Node:** ${report.meta.node}`)
  lines.push(`- **Platform:** ${report.meta.platform}`)
  lines.push(
    `- **Cells:** ${report.totals.cells} (passed: ${report.totals.passed}, failed: ${report.totals.failed})`,
  )
  lines.push(`- **Total duration:** ${round2(report.totals.duration_ms / 1000)}s`)
  lines.push('')
  lines.push(`## Results`)
  lines.push('')
  lines.push(
    `| Benchmark | Backend | Provider | Reranker | Status | Duration | Headline metric |`,
  )
  lines.push(`|---|---|---|---|---|---|---|`)
  for (const r of report.results) {
    const status = r.ok ? '✅' : '❌'
    const duration = `${round2(r.durationMs / 1000)}s`
    const metric = r.ok ? headlineMetric(r) : (r.error ?? '—').slice(0, 80)
    lines.push(
      `| ${r.benchmark} | ${r.backend} | ${r.provider} | ${r.reranker} | ${status} | ${duration} | ${metric} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

function headlineMetric(r: CellResult): string {
  if (!r.report) return '—'
  if (r.benchmark === 'locomo') {
    return `evidence@K = ${r.report['evidence_topk_pct'] ?? '?'}%`
  }
  if (r.benchmark === 'longmemeval') {
    const overall = isRecord(r.report['overall']) ? r.report['overall'] : undefined
    return `evidence@K = ${overall?.['evidence_topk_pct'] ?? '?'}%`
  }
  if (r.benchmark === 'beam') {
    const ts = isRecord(r.report['token_savings']) ? r.report['token_savings'] : undefined
    const recall = isRecord(r.report['recall']) ? r.report['recall'] : undefined
    return `savings = ${ts?.['savings_pct'] ?? '?'}%, p95 = ${recall?.['p95_ms'] ?? '?'}ms`
  }
  return '—'
}

interface CliOptions {
  configPath?: string
  outputDir: string
  overrides: Partial<MatrixConfig>
}

function parseOptions(): CliOptions {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string' },
      'output-dir': { type: 'string' },
      benchmarks: { type: 'string' },
      backends: { type: 'string' },
      providers: { type: 'string' },
      rerankers: { type: 'string' },
      'top-k': { type: 'string' },
      threshold: { type: 'string' },
    },
  })

  const overrides: Partial<MatrixConfig> = {}
  if (values.benchmarks)
    overrides.benchmarks = (values.benchmarks as string).split(',') as BenchmarkName[]
  if (values.backends)
    overrides.backends = (values.backends as string).split(',') as BackendName[]
  if (values.providers)
    overrides.providers = (values.providers as string).split(',') as Provider[]
  if (values.rerankers)
    overrides.rerankers = (values.rerankers as string).split(',') as Array<'lexical' | 'http' | 'off'>
  if (values['top-k']) overrides.topK = Number(values['top-k'])
  if (values.threshold) overrides.threshold = Number(values.threshold)

  return {
    ...(values.config ? { configPath: resolve(values.config as string) } : {}),
    outputDir: resolve((values['output-dir'] as string | undefined) ?? './benchmarks/reports'),
    overrides,
  }
}

void readJsonSafe
void fileExists

main().catch((err) => {
  log.error('sweep failed', { err: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
