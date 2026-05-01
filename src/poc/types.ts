/**
 * POC-- atom — time-boxed hypothesis-test artifact (ADR--ADD-POC-PREFIX).
 *
 * Light-tier governance:
 *   • storage: <root>/gks/poc/POC--<NAME>.md
 *   • write path: direct (no inbound queue) — POCs need to start fast
 *   • lifecycle: open → running → validated | invalidated | abandoned
 *   • after time_box.deadline with no closure, the pre-commit hook blocks
 *     commits that touch any linked_symbols path
 */

import type { LinkedSymbol, Phase } from '../memory/types.js'
import { isAtomicId } from '../memory/atomic-id.js'

export type PocStatus =
  | 'open'         // declared, hypothesis written, not yet started
  | 'running'      // experiment in progress
  | 'validated'    // hypothesis confirmed by acceptance_criteria
  | 'invalidated'  // hypothesis disproven by acceptance_criteria
  | 'abandoned'    // experiment stopped before conclusion (timeout, pivot, deprioritised)

export interface PocTimeBox {
  opened_at: string                // ISO-8601 UTC
  deadline: string                 // ISO-8601 UTC — REQUIRED, no default
  closed_at?: string | null        // set when status leaves open/running
}

export interface PocCrosslinks {
  derives_from?: string[]          // CONCEPT-- the hypothesis came from
  produces?: string[]              // BLUEPRINT-- / AUDIT-- the POC writes
  feeds_into?: string[]            // ADR-- this POC informs (post-closure)
  references?: string[]
}

export interface Poc {
  id: string                       // POC--<NAME> (slug, not sha)
  phase: Phase                     // 1 by convention — sits between CONCEPT and BLUEPRINT
  type: 'poc'
  status: PocStatus
  title: string
  hypothesis: string               // REQUIRED, one paragraph, falsifiable
  acceptance_criteria: string[]    // REQUIRED, ≥1 entry
  time_box: PocTimeBox
  resolution?: PocStatus           // copy of final status for fast filter
  linked_symbols?: LinkedSymbol[]
  crosslinks?: PocCrosslinks
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validatePoc(p: Partial<Poc>): ValidationResult {
  const errors: string[] = []

  if (!p.id) errors.push('missing id')
  else if (!isAtomicId(p.id)) errors.push(`invalid id format: ${p.id}`)
  else if (!p.id.startsWith('POC--')) errors.push(`id must start with POC-- (got ${p.id})`)

  if (p.type !== 'poc') errors.push(`type must be 'poc' (got ${String(p.type)})`)
  if (p.phase !== 1) errors.push(`phase must be 1 for POCs (got ${p.phase})`)
  if (!p.title || p.title.length === 0) errors.push('missing title')
  if (!p.hypothesis || p.hypothesis.trim().length === 0) errors.push('missing hypothesis')
  if (!p.acceptance_criteria || p.acceptance_criteria.length === 0) {
    errors.push('acceptance_criteria must have ≥1 entry')
  }
  if (!p.time_box?.opened_at) errors.push('missing time_box.opened_at')
  if (!p.time_box?.deadline) errors.push('missing time_box.deadline (REQUIRED — POCs must terminate)')

  // closed_at must be set iff status is terminal
  const terminal: PocStatus[] = ['validated', 'invalidated', 'abandoned']
  if (p.status && terminal.includes(p.status) && !p.time_box?.closed_at) {
    errors.push(`status=${p.status} requires time_box.closed_at`)
  }
  if (p.status && !terminal.includes(p.status) && p.time_box?.closed_at) {
    errors.push(`time_box.closed_at set but status=${p.status} is not terminal`)
  }

  return { valid: errors.length === 0, errors }
}

export function makePocId(slug: string): string {
  const norm = slug
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
  return `POC--${norm}`
}

/**
 * True iff `now` is past the POC's deadline AND status is still open/running.
 * Used by the pre-commit hook to block commits on `linked_symbols` paths.
 */
export function isOverdue(p: Poc, now: Date = new Date()): boolean {
  if (p.status !== 'open' && p.status !== 'running') return false
  return new Date(p.time_box.deadline).getTime() < now.getTime()
}

/** Whether the POC has reached a conclusion (any terminal status). */
export function isClosed(p: Poc): boolean {
  return p.status === 'validated' || p.status === 'invalidated' || p.status === 'abandoned'
}
