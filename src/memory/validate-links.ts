/**
 * Link integrity checker — `gks validate --links` (ADR-014 item 6).
 *
 * Walks every atom in the index and asserts that every entry under
 * `crosslinks.*` resolves to an existing atom id. Optional, read-only.
 *
 * Out of scope (orchestrator's job per ADR-009):
 *   • Body wikilinks (`[[FOO--BAR]]`) — they live in atom bodies and
 *     require markdown parsing GKS shouldn't take on; the orchestrator
 *     can stream bodies through `lookup` if it wants to validate them.
 *   • Symbol-existence — that's GitNexus territory.
 */

import type { AtomicEntry } from './types.js'

export interface LinkError {
  /** Atom that holds the broken citation. */
  from: string
  /** Crosslink key (e.g. `references`, `parent_blueprint`). */
  via: string
  /** The unresolved id. */
  target: string
}

export interface ValidateLinksResult {
  ok: boolean
  scanned: number
  errors: LinkError[]
}

/**
 * Pure function over the entries map; the CLI loads the index and
 * formats the output. Walks every crosslink key — not just the ones
 * verify-flow recognises — so authors get coverage for custom ones too.
 */
export function validateLinks(byId: Map<string, AtomicEntry>): ValidateLinksResult {
  const errors: LinkError[] = []
  let scanned = 0
  for (const entry of byId.values()) {
    scanned++
    if (!entry.crosslinks) continue
    for (const [via, targets] of Object.entries(entry.crosslinks)) {
      if (!Array.isArray(targets)) continue
      for (const target of targets) {
        if (typeof target !== 'string' || target.length === 0) continue
        if (!byId.has(target)) {
          errors.push({ from: entry.id, via, target })
        }
      }
    }
  }
  return { ok: errors.length === 0, scanned, errors }
}

export function formatValidateLinksResult(result: ValidateLinksResult): string[] {
  const lines: string[] = []
  lines.push(`validate-links: scanned ${result.scanned} atom(s)`)
  if (result.ok) {
    lines.push('  status: OK')
    return lines
  }
  lines.push(`  status: FAILED (${result.errors.length} broken link(s))`)
  for (const err of result.errors) {
    lines.push(`  ✗ ${err.from} → ${err.target} (via crosslinks.${err.via})`)
  }
  return lines
}
