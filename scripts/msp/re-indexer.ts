/**
 * Atomic index re-builder.
 *
 * Walks `gks/**\/*.md`, parses YAML frontmatter, and writes a normalised
 * `gks/00_index/atomic_index.jsonl` so the AtomicLayer + lookupBySymbol
 * (ADR-010) have a populated index without anyone hand-editing the JSONL.
 *
 * In scope per ADR-008: this is a storage primitive — same role as
 * `npm run re-embed` but for the atomic layer instead of the vector
 * layer. Out-of-scope concerns explicitly NOT addressed here:
 *   • Promote workflow (inbound → gks/) — orchestrator's job
 *   • Validating that wikilinks resolve / IDs unique against contract —
 *     orchestrator's job (msp:validate / drift checks)
 *   • Symbol-existence verification against the codebase — GitNexus's
 *     job per ADR-009
 *
 * Usage:
 *   npm run msp:index                                     # default <cwd>
 *   tsx scripts/msp/re-indexer.ts --root=/path/to/repo
 *   tsx scripts/msp/re-indexer.ts --dry-run               # preview only
 *   tsx scripts/msp/re-indexer.ts --verbose               # list each file
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { parse as parseYaml } from 'yaml'

import { gksLayout } from '../../src/memory/index.js'
import { isAtomicId } from '../../src/memory/atomic-id.js'
import { normaliseStatus } from '../../src/memory/types.js'

interface IndexRow {
  id: string
  phase: number
  type: string
  status: string
  vault_id: string
  path: string
  title?: string
  tags?: string[]
  crosslinks?: Record<string, string[]>
  valid_from?: string
  valid_to?: string | null
  linked_symbols?: unknown[]
  geography?: string[]
}

async function* walkMarkdown(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip the index dir itself — we're rebuilding it.
      if (entry.name === '00_index') continue
      yield* walkMarkdown(p)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield p
    }
  }
}

function extractFrontmatter(text: string): Record<string, unknown> | null {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const fmText = text.slice(3, end).trim()
  try {
    const parsed = parseYaml(fmText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

function asPhase(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5) return v
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10)
    if (Number.isFinite(n) && n >= 0 && n <= 5) return n
  }
  return undefined
}

function rowFromFrontmatter(
  fm: Record<string, unknown>,
  pathRel: string,
): { row: IndexRow | null; reason?: string } {
  const id = asString(fm['id'])
  if (!id) return { row: null, reason: 'missing id' }
  if (!isAtomicId(id)) return { row: null, reason: `invalid id format: ${id}` }

  const phase = asPhase(fm['phase'])
  if (phase === undefined) return { row: null, reason: 'missing/invalid phase' }

  const type = asString(fm['type'])
  if (!type) return { row: null, reason: 'missing type' }

  const status = normaliseStatus(asString(fm['status'])) ?? 'draft'
  const vault_id = asString(fm['vault_id']) ?? 'default'

  const row: IndexRow = { id, phase, type, status, vault_id, path: pathRel }

  const title = asString(fm['title'])
  if (title) row.title = title

  const tags = asStringArray(fm['tags'])
  if (tags) row.tags = tags

  // crosslinks: { implements: [...], references: [...], ... }
  if (fm['crosslinks'] && typeof fm['crosslinks'] === 'object' && !Array.isArray(fm['crosslinks'])) {
    const cl: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(fm['crosslinks'] as Record<string, unknown>)) {
      const arr = asStringArray(v)
      if (arr) cl[k] = arr
    }
    if (Object.keys(cl).length > 0) row.crosslinks = cl
  }

  if (asString(fm['valid_from'])) row.valid_from = asString(fm['valid_from'])
  if (fm['valid_to'] === null) row.valid_to = null
  else if (asString(fm['valid_to'])) row.valid_to = asString(fm['valid_to'])

  // linked_symbols: array of { file, fn?, line? } — ADR-010
  if (Array.isArray(fm['linked_symbols'])) {
    const filtered = fm['linked_symbols'].filter(
      (s) => s && typeof s === 'object' && !Array.isArray(s) && typeof (s as { file?: unknown }).file === 'string',
    )
    if (filtered.length > 0) row.linked_symbols = filtered
  }

  // geography: blueprint-style file paths — ADR-010
  const geography = asStringArray(fm['geography'])
  if (geography) row.geography = geography

  return { row }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string' },
      'dry-run': { type: 'boolean' },
      verbose: { type: 'boolean' },
    },
  })
  const root = resolve(values['root'] ?? process.cwd())
  const dryRun = values['dry-run'] === true
  const verbose = values['verbose'] === true

  const layout = gksLayout(root)
  console.log(`[index] gks root:    ${layout.gks}`)
  console.log(`[index] output:      ${layout.atomicIndex}${dryRun ? '  (dry-run)' : ''}`)

  const rows: IndexRow[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  let scanned = 0

  for await (const file of walkMarkdown(layout.gks)) {
    scanned++
    const pathRel = relative(layout.gks, file)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      skipped.push({ path: pathRel, reason: 'read error' })
      continue
    }

    const fm = extractFrontmatter(text)
    if (!fm) {
      skipped.push({ path: pathRel, reason: 'no frontmatter' })
      continue
    }

    const { row, reason } = rowFromFrontmatter(fm, pathRel)
    if (!row) {
      skipped.push({ path: pathRel, reason: reason ?? 'invalid' })
      continue
    }
    rows.push(row)
    if (verbose) console.log(`  + ${row.id}  ${pathRel}`)
  }

  // Dedup by id (keep first; warn on duplicates).
  const seen = new Set<string>()
  const deduped: IndexRow[] = []
  let duplicates = 0
  for (const r of rows) {
    if (seen.has(r.id)) {
      duplicates++
      console.warn(`[index] duplicate id ${r.id} at ${r.path} — keeping first occurrence`)
      continue
    }
    seen.add(r.id)
    deduped.push(r)
  }

  // Sort for deterministic output (matters for diff-friendly indexes).
  deduped.sort((a, b) => a.id.localeCompare(b.id))

  console.log(`[index] scanned:     ${scanned}`)
  console.log(`[index] indexed:     ${deduped.length}`)
  console.log(`[index] skipped:     ${skipped.length}`)
  console.log(`[index] duplicates:  ${duplicates}`)

  if (skipped.length > 0 && verbose) {
    for (const s of skipped) console.log(`  - ${s.path}  (${s.reason})`)
  }

  if (dryRun) {
    console.log('[index] dry-run — no write')
    return
  }

  // Atomic write: build the body in memory, ensure dir, write once.
  const body = deduped.map((r) => JSON.stringify(r)).join('\n') + (deduped.length > 0 ? '\n' : '')
  await mkdir(dirname(layout.atomicIndex), { recursive: true })
  await writeFile(layout.atomicIndex, body, 'utf8')
  console.log(`[index] wrote ${layout.atomicIndex}`)
}

main().catch((err) => {
  console.error('[index] failed:', (err as Error).message)
  process.exit(1)
})
