/**
 * Issue types — schema + enums + validators for the self-hosted issue
 * tracker introduced by ADR-012.
 *
 * Issues live in the *light-governance* tier (`gks/issues/<ID>.md`):
 * direct write OK, schema-validated at every mutation, comments are
 * append-only by convention. Strict-tier atoms (ADR / FEAT / BLUEPRINT)
 * still go through the inbound queue.
 *
 * Anything that ends up in frontmatter goes through `validateIssue()`.
 */

import type { LinkedSymbol, Phase } from '../memory/types.js'
import { isAtomicId } from '../memory/atomic-id.js'

export const ISSUE_STATUSES = [
  'open',
  'triaged',
  'in_progress',
  'blocked',
  'closed',
  'wontfix',
] as const

export type IssueStatus = (typeof ISSUE_STATUSES)[number]

export const ISSUE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number]

export interface IssueCrosslinks {
  related_incidents?: string[]
  resolved_by?: string[]
  duplicates_of?: string[]
  blocks?: string[]
  blocked_by?: string[]
}

export interface Issue {
  id: string                          // ISSUE--TYPE-SLUG
  phase: Phase                        // always 2 by convention
  type: 'issue'
  status: IssueStatus
  priority: IssuePriority
  title: string
  assignee?: string                   // MSP-AGT-... or MSP-USR-...
  reporter?: string
  labels?: string[]
  created_at: string                  // ISO-8601 UTC
  updated_at: string
  closed_at?: string                  // set when status flips to closed/wontfix
  linked_symbols?: LinkedSymbol[]
  crosslinks?: IssueCrosslinks
}

/**
 * Body sections we recognise in the .md file. The CLI's `comment`
 * command appends to the Discussion section; everything else is
 * authored by humans.
 */
export interface IssueBody {
  description?: string                // first paragraph(s) under "# ISSUE — <title>"
  reproduction?: string               // "## Reproduction"
  impact?: string                     // "## Impact"
  discussion: string[]                // "## Discussion" sub-blocks (### timestamp [actor] action)
  resolution?: string                 // "## Resolution"
  raw: string                         // full body text (for round-trip preservation)
}

// ─── validation ────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateIssue(issue: Partial<Issue>): ValidationResult {
  const errors: string[] = []

  if (!issue.id) errors.push('missing id')
  else if (!isAtomicId(issue.id)) errors.push(`invalid id format: ${issue.id}`)
  else if (!issue.id.startsWith('ISSUE--')) errors.push(`id must start with ISSUE-- (got ${issue.id})`)

  if (issue.type !== 'issue') errors.push(`type must be 'issue' (got ${String(issue.type)})`)
  if (issue.phase !== 2) errors.push(`phase must be 2 for issues (got ${issue.phase})`)

  if (!issue.status) errors.push('missing status')
  else if (!ISSUE_STATUSES.includes(issue.status as IssueStatus)) {
    errors.push(`invalid status '${issue.status}' (must be one of: ${ISSUE_STATUSES.join(' | ')})`)
  }

  if (!issue.priority) errors.push('missing priority')
  else if (!ISSUE_PRIORITIES.includes(issue.priority as IssuePriority)) {
    errors.push(`invalid priority '${issue.priority}' (must be one of: ${ISSUE_PRIORITIES.join(' | ')})`)
  }

  if (!issue.title || issue.title.length === 0) errors.push('missing title')

  if (!issue.created_at) errors.push('missing created_at')
  if (!issue.updated_at) errors.push('missing updated_at')

  return { valid: errors.length === 0, errors }
}

export function isValidStatus(s: string): s is IssueStatus {
  return (ISSUE_STATUSES as readonly string[]).includes(s)
}

export function isValidPriority(s: string): s is IssuePriority {
  return (ISSUE_PRIORITIES as readonly string[]).includes(s)
}

// ─── id helpers ────────────────────────────────────────────────────────────

/**
 * Slugify a free-text title into the SLUG portion of an ISSUE-- id.
 * Matches `ATOMIC_ID_PATTERN` requirements: starts with letter/digit,
 * uppercase A-Z 0-9 _ - only.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  // Guarantee it starts with [A-Z0-9]; isAtomicId enforces this.
  return slug.length > 0 && /^[A-Z0-9]/.test(slug) ? slug : `ISSUE-${Date.now().toString(36).toUpperCase()}`
}

/**
 * Build a deterministic issue id from a title + optional disambiguator.
 * Uses a 6-char timestamp suffix when colliding with existing ids isn't
 * acceptable; callers can decide via `disambiguate=true`.
 */
export function makeIssueId(title: string, disambiguate = false): string {
  const slug = slugifyTitle(title)
  if (disambiguate) {
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()
    return `ISSUE--${slug}-${suffix}`
  }
  return `ISSUE--${slug}`
}
