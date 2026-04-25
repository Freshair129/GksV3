/**
 * Atomic ID helpers.
 *
 * The pattern `TYPE--SLUG` (e.g. `CONCEPT--EVA-TRI-BRAIN`) showed up in
 * five places — inbound queue validation, MCP server tool schemas, the
 * AtomicLayer regex, and the consolidator's LLM-output validator. Two of
 * the copies had drifted regex syntax (escaped `\-` vs bare `-` in the
 * trailing class). One source so the next tightening lands everywhere.
 */

/** Canonical atomic ID pattern: TYPE--SLUG. */
export const ATOMIC_ID_PATTERN = /^[A-Z][A-Z0-9_]*--[A-Z0-9][A-Z0-9_-]*$/

export function isAtomicId(s: string): boolean {
  return ATOMIC_ID_PATTERN.test(s)
}

/** Throws with a helpful message. Use in factory paths where invalid IDs are bugs. */
export function assertAtomicId(s: string, context = 'atomic id'): void {
  if (!isAtomicId(s)) {
    throw new Error(
      `${context}: invalid id '${s}' — must match TYPE--SLUG (e.g. CONCEPT--FOO-BAR)`,
    )
  }
}
