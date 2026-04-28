/**
 * Chain walker — `gks verify-flow <id>` (ADR-014 item 3).
 *
 * Starting from a `FEAT--` (or any atom), walk the `crosslinks` graph
 * and assert that every reachable node is `isApprovedStatus`. Reports
 * the first broken edge with file path + reason. Designed to compose
 * into pre-commit / CI gates (exits non-zero on failure).
 *
 * Edges walked (in order of priority):
 *   • crosslinks.references     — atom → atoms it depends on
 *   • crosslinks.implements     — atom → spec it implements (FEAT/ADR)
 *   • crosslinks.parent_blueprint — TASK--   → BLUEPRINT-- it sits under
 *   • crosslinks.resolves       — backfill atom → HOTFIX-- it closes
 *
 * Out of scope here:
 *   • Symbol-existence verification — orchestrator's job (ADR-009)
 *   • Cycle handling beyond the visited set — atoms shouldn't cite each
 *     other in cycles; if they do, we visit each once and move on.
 */

import type { AtomicEntry } from './types.js'
import { isApprovedStatus } from './types.js'

/** One link traversed during the walk. */
export interface WalkedEdge {
  from: string
  to: string
  via: 'references' | 'implements' | 'parent_blueprint' | 'resolves'
}

/** A reason the chain isn't healthy. */
export interface VerifyError {
  /** Atom whose status / link is bad. */
  id: string
  kind: 'missing' | 'not_approved' | 'broken_crosslink'
  reason: string
  /** For broken_crosslink: the unresolved id. */
  target?: string
  /** Edge type that surfaced the problem. */
  via?: WalkedEdge['via']
}

export interface VerifyFlowResult {
  ok: boolean
  start: string
  visited: AtomicEntry[]
  edges: WalkedEdge[]
  errors: VerifyError[]
}

const RELEVANT_LINKS: WalkedEdge['via'][] = [
  'references',
  'implements',
  'parent_blueprint',
  'resolves',
]

/**
 * Walk the chain rooted at `startId`. Pure function over the entries
 * map; the CLI surface is responsible for loading the index and
 * formatting output.
 */
export function verifyFlow(startId: string, byId: Map<string, AtomicEntry>): VerifyFlowResult {
  const visited = new Set<string>()
  const order: AtomicEntry[] = []
  const edges: WalkedEdge[] = []
  const errors: VerifyError[] = []

  const queue: string[] = [startId]

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)

    const entry = byId.get(id)
    if (!entry) {
      errors.push({ id, kind: 'missing', reason: `atom not in index: ${id}` })
      continue
    }
    order.push(entry)

    if (!isApprovedStatus(entry.status)) {
      errors.push({
        id,
        kind: 'not_approved',
        reason: `status is '${entry.status}', expected 'stable' (or 'approved')`,
      })
      // continue walking — we want to surface every issue, not just the first
    }

    if (!entry.crosslinks) continue
    for (const via of RELEVANT_LINKS) {
      const targets = entry.crosslinks[via]
      if (!Array.isArray(targets)) continue
      for (const target of targets) {
        if (typeof target !== 'string' || target.length === 0) continue
        edges.push({ from: id, to: target, via })
        if (!byId.has(target)) {
          errors.push({
            id,
            kind: 'broken_crosslink',
            reason: `crosslinks.${via} cites missing atom`,
            target,
            via,
          })
          continue
        }
        queue.push(target)
      }
    }
  }

  return { ok: errors.length === 0, start: startId, visited: order, edges, errors }
}

/** Pretty-print a result for CLI output. Returns the formatted lines. */
export function formatVerifyFlowResult(result: VerifyFlowResult): string[] {
  const lines: string[] = []
  lines.push(`verify-flow ${result.start}`)
  lines.push(`  visited: ${result.visited.length} atom(s)`)
  lines.push(`  edges:   ${result.edges.length} crosslink(s)`)
  if (result.ok) {
    lines.push('  status:  OK')
    return lines
  }
  lines.push(`  status:  FAILED (${result.errors.length} issue(s))`)
  for (const err of result.errors) {
    if (err.kind === 'missing') {
      lines.push(`  ✗ ${err.id}: ${err.reason}`)
    } else if (err.kind === 'not_approved') {
      lines.push(`  ✗ ${err.id}: ${err.reason}`)
    } else {
      lines.push(`  ✗ ${err.id} → ${err.target} (via ${err.via}): ${err.reason}`)
    }
  }
  return lines
}
