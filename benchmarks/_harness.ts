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
import { resolve } from 'node:path'

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
} as const satisfies ParseArgsConfig['options']

export interface BaseBenchOptions {
  datasetPath: string
  workDir: string
  topK: number
  scoreThreshold: number
  limit?: number
  provider: Provider
  fresh: boolean
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

  return {
    base: {
      datasetPath,
      workDir,
      topK,
      scoreThreshold,
      ...(limit !== undefined ? { limit } : {}),
      provider,
      fresh,
    },
    values: raw,
  }
}

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
