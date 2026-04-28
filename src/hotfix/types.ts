/**
 * HOTFIX-- atom — escape hatch for prod-down fixes that ship before
 * P1-P3 atoms exist (master-spec §6.4, ADR-014).
 *
 * Light-tier governance:
 *   • storage: <root>/gks/hotfix/HOTFIX--<short-sha>.md
 *   • write path: direct (no inbound queue) — incidents don't wait for review
 *   • lifecycle: opened with valid_to = now + 48 h; closed when backfill atoms
 *     declare crosslinks.resolves: [HOTFIX--<short-sha>]
 *   • after valid_to with backfill incomplete, the pre-commit hook blocks
 *     commits that touch any of the affected files
 */

import type { LinkedSymbol, Phase } from '../memory/types.js'
import { isAtomicId } from '../memory/atomic-id.js'

/** 48 hours in milliseconds — the backfill window per master-spec §6.4. */
export const HOTFIX_BACKFILL_MS = 48 * 60 * 60 * 1000

export interface HotfixCrosslinks {
  related_incidents?: string[]   // INC-- if a post-mortem exists
  resolved_by?: string[]         // CONCEPT-- / ADR-- / BLUEPRINT-- that closed the backfill
}

export interface HotfixMeta {
  commit_sha: string             // full SHA of the hotfix commit
  ref?: string                   // branch / tag (informational)
  reason?: string                // one-line why the bypass
}

export interface Hotfix {
  id: string                     // HOTFIX--<7-char short sha>
  phase: Phase                   // 5 by convention — fix landed in implementation phase
  type: 'hotfix'
  status: 'stable' | 'deprecated'
  title: string                  // one-line summary
  created_at: string             // ISO-8601 UTC
  valid_from: string             // = commit time
  valid_to: string               // = commit time + 48 h
  closed_at?: string             // when the backfill is verified complete
  linked_symbols?: LinkedSymbol[]
  crosslinks?: HotfixCrosslinks
  meta: HotfixMeta
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateHotfix(h: Partial<Hotfix>): ValidationResult {
  const errors: string[] = []

  if (!h.id) errors.push('missing id')
  else if (!isAtomicId(h.id)) errors.push(`invalid id format: ${h.id}`)
  else if (!h.id.startsWith('HOTFIX--')) errors.push(`id must start with HOTFIX-- (got ${h.id})`)

  if (h.type !== 'hotfix') errors.push(`type must be 'hotfix' (got ${String(h.type)})`)
  if (h.phase !== 5) errors.push(`phase must be 5 for hotfixes (got ${h.phase})`)
  if (!h.title || h.title.length === 0) errors.push('missing title')
  if (!h.valid_from) errors.push('missing valid_from')
  if (!h.valid_to) errors.push('missing valid_to')
  if (!h.meta?.commit_sha) errors.push('missing meta.commit_sha')

  return { valid: errors.length === 0, errors }
}

export function shortSha(fullSha: string): string {
  return fullSha.replace(/[^a-fA-F0-9]/g, '').slice(0, 7).toUpperCase()
}

export function makeHotfixId(commitSha: string): string {
  return `HOTFIX--${shortSha(commitSha)}`
}

/**
 * True iff `now` is past the hotfix's valid_to AND its backfill hasn't
 * been declared resolved. Used by the pre-commit hook.
 */
export function isOverdue(h: Hotfix, now: Date = new Date()): boolean {
  if (h.closed_at) return false
  return new Date(h.valid_to).getTime() < now.getTime()
}
