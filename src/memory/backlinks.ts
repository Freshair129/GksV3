/**
 * Backlinks derivation — flat edge list over the atomic index.
 *
 * Memory OS layers above GKS (MSP, EVA) repeatedly need a `(from, to, type)`
 * edge list derived from `crosslinks.*` to drive doc graphs and traversal
 * caches. This module is the single source of truth so every consumer
 * agrees on the edge shape and ordering.
 *
 * Pure derivation: walks the loaded index entries; does not read note bodies.
 * Output is sorted by `(from, to, type)` for git-diff stability when the
 * caller chooses to persist it.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AtomicEntry } from './types.js'
import type { AtomicLayer } from './gks.js'

/** Single directed edge. `type` matches the `crosslinks.<type>` key. */
export interface BacklinkEdge {
  from: string
  to: string
  type: string
}

export interface DeriveBacklinksOptions {
  /**
   * Restrict to these crosslink types. Default: undefined → emit every
   * crosslink type observed in the index.
   *
   * Common keys: `references`, `implements`, `parent_blueprint`,
   * `resolves`, `superseded_by`, `supersedes`.
   */
  filterTypes?: string[]
  /**
   * Sort the output by `(from, to, type)` before returning. Default true —
   * stable ordering is important when the caller persists the list (avoids
   * spurious git diffs).
   */
  sort?: boolean
}

/**
 * Derive a flat list of backlink edges from the atomic index.
 *
 * Calls `loadIndex()` for the caller — pass an already-loaded `AtomicLayer`
 * if you want to avoid the round-trip. The walk is O(N × avgFanout) over
 * the in-memory entries; suitable for hundreds-to-low-thousands of atoms.
 */
export async function deriveBacklinks(
  atomic: AtomicLayer,
  opts: DeriveBacklinksOptions = {},
): Promise<BacklinkEdge[]> {
  await atomic.loadIndex()
  const entries = atomic.filter({})
  return deriveBacklinksFromEntries(entries, opts)
}

/**
 * Sync variant operating on a pre-loaded entries array. Useful for callers
 * that already have the index (e.g. `verify-flow`) and want to skip a
 * second `loadIndex()`.
 */
export function deriveBacklinksFromEntries(
  entries: Iterable<AtomicEntry>,
  opts: DeriveBacklinksOptions = {},
): BacklinkEdge[] {
  const allow = opts.filterTypes && opts.filterTypes.length > 0
    ? new Set(opts.filterTypes)
    : null
  const sort = opts.sort ?? true

  const edges: BacklinkEdge[] = []
  for (const entry of entries) {
    const links = entry.crosslinks
    if (!links) continue
    for (const [type, targets] of Object.entries(links)) {
      if (allow && !allow.has(type)) continue
      if (!Array.isArray(targets)) continue
      for (const target of targets) {
        if (typeof target !== 'string' || target.length === 0) continue
        edges.push({ from: entry.id, to: target, type })
      }
    }
  }

  if (sort) edges.sort(compareEdge)
  return edges
}

/**
 * Persist the derived backlinks to a file. Returns the on-disk byte count
 * and edge count so callers can log a single summary line.
 *
 * Format is selected by the file extension:
 *   `.jsonl` (default)  → one edge per line, compact JSON
 *   `.json`             → array of edges, two-space indented
 */
export async function emitBacklinks(
  atomic: AtomicLayer,
  outPath: string,
  opts: DeriveBacklinksOptions & { format?: 'jsonl' | 'json' } = {},
): Promise<{ edgeCount: number; bytes: number; path: string }> {
  const edges = await deriveBacklinks(atomic, opts)
  const format = opts.format ?? (outPath.endsWith('.json') ? 'json' : 'jsonl')
  const text = format === 'json'
    ? JSON.stringify(edges, null, 2) + '\n'
    : edges.map((e) => JSON.stringify(e)).join('\n') + (edges.length > 0 ? '\n' : '')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, text, 'utf8')
  return { edgeCount: edges.length, bytes: Buffer.byteLength(text, 'utf8'), path: outPath }
}

function compareEdge(a: BacklinkEdge, b: BacklinkEdge): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1
  if (a.to !== b.to) return a.to < b.to ? -1 : 1
  if (a.type !== b.type) return a.type < b.type ? -1 : 1
  return 0
}
