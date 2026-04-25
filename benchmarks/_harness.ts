/**
 * Shared plumbing for LoCoMo / LongMemEval / BEAM runners.
 *
 * Extracted after three code-reviews found 5-6 helpers duplicated verbatim
 * (plus a fourth in re-embed.ts). Keeping them here prevents metric-formula
 * drift across runners — e.g. one runner accidentally switching pct() to
 * 3-digit precision without the others noticing.
 *
 * Intentionally minimal: only utilities that ≥ 2 runners need. Runner-specific
 * logic (LoCoMo evidence scoring, LongMemEval temporal check, BEAM token-
 * savings calc) stays in each runner.
 */

import { parseArgs, type ParseArgsConfig } from 'node:util'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  createHnswBackend,
  createPgvectorBackend,
  type Embedder,
  type RerankerOptions,
  type VectorBackend,
  type VectorBackendFactory,
} from '../src/memory/index.js'
import { createLogger } from '../src/lib/logger.js'

const log = createLogger('bench:harness')

// ─── metrics ───────────────────────────────────────────────────────────────

export function pct(n: number, d: number): number {
  if (!d) return 0
  return round2((n / d) * 100)
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.floor((p / 100) * (sorted.length - 1))
  return sorted[idx]!
}

// ─── CLI shared options ────────────────────────────────────────────────────

export type Provider = 'auto' | 'ollama' | 'openai' | 'mock'
export type BackendName = 'jsonl' | 'hnsw' | 'pgvector'

/**
 * Shape every runner parses: dataset path, workdir, top-k, threshold, limit,
 * embedder provider, fresh-workdir toggle. Individual runners add their own
 * keys on top via parseArgs' options.
 */
export const BENCH_BASE_ARG_OPTIONS = {
  dataset: { type: 'string' },
  'work-dir': { type: 'string' },
  'top-k': { type: 'string' },
  threshold: { type: 'string' },
  limit: { type: 'string' },
  provider: { type: 'string' },
  fresh: { type: 'boolean' },
  backend: { type: 'string' },
  'rerank-endpoint': { type: 'string' },
  'rerank-api-key': { type: 'string' },
  'pg-url': { type: 'string' },
  'pg-table': { type: 'string' },
  'hnsw-ef-search': { type: 'string' },
} as const satisfies ParseArgsConfig['options']

export interface BaseBenchOptions {
  datasetPath: string
  workDir: string
  topK: number
  scoreThreshold: number
  limit?: number
  provider: Provider
  fresh: boolean
  backend: BackendName
  rerank?: RerankerOptions
  pgUrl?: string
  pgTable?: string
  hnswEfSearch?: number
}

/**
 * Parse the common flags. Runners call this first, then read their extra
 * keys from `values` directly. Returns the raw `values` alongside the
 * normalized base options so callers don't re-parse.
 */
export function parseBaseBenchArgs(
  defaults: {
    datasetEnvVar: string
    datasetDefaultPath: string
    workDirDefault: string
    topKDefault: number
    thresholdDefault: number
    topKEnvVar?: string
    thresholdEnvVar?: string
  },
  extra?: ParseArgsConfig['options'],
): { base: BaseBenchOptions; values: Record<string, unknown> } {
  const merged: ParseArgsConfig['options'] = { ...BENCH_BASE_ARG_OPTIONS, ...(extra ?? {}) }
  const { values } = parseArgs({ args: process.argv.slice(2), options: merged })
  const raw = values as Record<string, unknown>

  const datasetPath = resolve(
    (raw['dataset'] as string | undefined) ??
      process.env[defaults.datasetEnvVar] ??
      defaults.datasetDefaultPath,
  )
  const workDir = resolve(
    (raw['work-dir'] as string | undefined) ?? defaults.workDirDefault,
  )
  const topK = Number(
    raw['top-k'] ??
      (defaults.topKEnvVar ? process.env[defaults.topKEnvVar] : undefined) ??
      defaults.topKDefault,
  )
  const scoreThreshold = Number(
    raw['threshold'] ??
      (defaults.thresholdEnvVar ? process.env[defaults.thresholdEnvVar] : undefined) ??
      defaults.thresholdDefault,
  )
  const limit = raw['limit'] ? Number(raw['limit']) : undefined
  const provider = (raw['provider'] as Provider | undefined) ?? 'auto'
  const fresh = raw['fresh'] !== false

  const backendRaw = (raw['backend'] as string | undefined) ?? process.env['GKS_BENCH_BACKEND'] ?? 'jsonl'
  if (backendRaw !== 'jsonl' && backendRaw !== 'hnsw' && backendRaw !== 'pgvector') {
    throw new Error(`bench: invalid --backend='${backendRaw}' (expected: jsonl | hnsw | pgvector)`)
  }
  const backend = backendRaw as BackendName

  const rerankEndpoint =
    (raw['rerank-endpoint'] as string | undefined) ?? process.env['GKS_RERANK_ENDPOINT']
  const rerankApiKey =
    (raw['rerank-api-key'] as string | undefined) ?? process.env['GKS_RERANK_API_KEY']
  const rerank: RerankerOptions | undefined = rerankEndpoint
    ? {
        backend: 'http',
        endpoint: rerankEndpoint,
        ...(rerankApiKey ? { apiKey: rerankApiKey } : {}),
      }
    : undefined

  const pgUrl = (raw['pg-url'] as string | undefined) ?? process.env['DATABASE_URL']
  const pgTable = (raw['pg-table'] as string | undefined) ?? process.env['GKS_VECTOR_TABLE']
  const hnswEfSearch = raw['hnsw-ef-search'] ? Number(raw['hnsw-ef-search']) : undefined

  if (backend === 'pgvector' && !pgUrl) {
    throw new Error(
      'bench: --backend=pgvector requires --pg-url=... or DATABASE_URL env var',
    )
  }

  return {
    base: {
      datasetPath,
      workDir,
      topK,
      scoreThreshold,
      ...(limit !== undefined ? { limit } : {}),
      provider,
      fresh,
      backend,
      ...(rerank ? { rerank } : {}),
      ...(pgUrl ? { pgUrl } : {}),
      ...(pgTable ? { pgTable } : {}),
      ...(hnswEfSearch !== undefined ? { hnswEfSearch } : {}),
    },
    values: raw,
  }
}

// ─── backend factory ───────────────────────────────────────────────────────

/**
 * Build a VectorBackendFactory + an optional cleanup hook for the runner.
 *
 *   - jsonl    : returns null → MemoryStore uses its built-in JSONL default.
 *   - hnsw     : returns a factory that creates one HnswBackend per name,
 *                rooted at <workDir>/.brain/.../vector/<name>.
 *   - pgvector : returns a factory backed by a single shared pg.Pool. The
 *                pool is closed by the returned `dispose()` callback.
 *
 * Runners pass the factory into `new MemoryStore({ vectorBackend, ... })`.
 */
export interface BenchBackend {
  factory: VectorBackendFactory | null
  dispose: () => Promise<void>
  description: string
}

export async function createBenchBackend(opts: BaseBenchOptions): Promise<BenchBackend> {
  if (opts.backend === 'jsonl') {
    return {
      factory: null,
      dispose: async () => {},
      description: 'jsonl (file-based default)',
    }
  }

  if (opts.backend === 'hnsw') {
    const factory: VectorBackendFactory = (name: string, embedder: Embedder) =>
      createHnswBackend({
        basePath: join(opts.workDir, '.brain', 'msp', 'projects', 'evaAI', 'vector', name),
        embedder,
        name,
        ...(opts.hnswEfSearch !== undefined ? { efSearch: opts.hnswEfSearch } : {}),
      })
    return {
      factory,
      dispose: async () => {},
      description: `hnsw${opts.hnswEfSearch !== undefined ? ` ef_search=${opts.hnswEfSearch}` : ''}`,
    }
  }

  // pgvector — lazy-import pg so the JSONL/HNSW paths don't pull in pg at startup.
  const pg = (await import('pg')).default
  const pool = new pg.Pool({ connectionString: opts.pgUrl })

  const factory: VectorBackendFactory = (name: string, embedder: Embedder): VectorBackend => {
    const backendOpts = {
      pool,
      embedder,
      name,
      ...(opts.pgTable ? { table: opts.pgTable } : {}),
    }
    return createPgvectorBackend(backendOpts)
  }

  return {
    factory,
    dispose: async () => {
      await pool.end()
    },
    description: `pgvector @ ${maskPgUrl(opts.pgUrl!)}${opts.pgTable ? ` (table=${opts.pgTable})` : ''}`,
  }
}

function maskPgUrl(url: string): string {
  return url.replace(/:[^@/]+@/, ':***@')
}

void log // keep the logger live for future use without churning imports

// ─── workspace ─────────────────────────────────────────────────────────────

export async function prepareWorkDir(dir: string, fresh: boolean): Promise<void> {
  if (fresh) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

// ─── reporting ─────────────────────────────────────────────────────────────

export function printReport(title: string, report: unknown): void {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(4, 60 - title.length)))
  console.log(JSON.stringify(report, null, 2))
  console.log('─'.repeat(66))
}
