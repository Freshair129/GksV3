/**
 * Minimal YAML renderer for frontmatter — single source of truth used by
 * episodic.ts (session summaries) and inbound.ts (proposal artifacts) so
 * both writers escape consistently.
 *
 * Why not depend on `yaml`? Frontmatter is tiny, predictable, and we only
 * write our own shape. A 30-line escaper avoids a runtime dep on the write
 * path; the read path uses the `yaml` package for richer / external input.
 *
 * Escapes any string that would break the colon-separated layout:
 * `:`, `#`, `-`, `[`, `]`, `{`, `}`, `\n`, leading/trailing whitespace —
 * any of which can let attacker-controlled values escape their field.
 */

export function yamlLite(obj: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      lines.push(`${k}: null`)
    } else if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`)
      else {
        lines.push(`${k}:`)
        for (const item of v) {
          // Objects in arrays render as flow-style JSON scalars — still
          // valid YAML, round-trips through any YAML parser, keeps nested
          // structures readable on one line per item.
          if (item !== null && typeof item === 'object') {
            lines.push(`  - ${JSON.stringify(item)}`)
          } else {
            lines.push(`  - ${yamlScalar(item)}`)
          }
        }
      }
    } else if (typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`)
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Quote a YAML scalar only when needed. YAML 1.2 treats most printable
 * characters as plain-safe inside scalars; the dangerous cases are:
 *   - leading reserved indicator: `-`/`?`/`:`/`,`/`[`/`]`/`{`/`}`/`#`/`&`/`*`
 *     `!`/`|`/`>`/`'`/`"`/`%`/`@`/backtick — could start a non-scalar
 *   - `: ` or `:` at end-of-string anywhere — splits key/value
 *   - ` #` anywhere — starts a comment
 *   - `\n` or `\r` — terminates the line
 *   - leading or trailing whitespace — trimmed by parsers
 *   - empty string — would parse as null
 * Atomic IDs like `INSIGHT--FOO` are plain-safe; only quote when one of
 * the above triggers fires.
 */
export function yamlScalar(v: unknown): string {
  if (typeof v !== 'string') return String(v)
  if (v === '') return '""'
  if (v.trim() !== v) return JSON.stringify(v)
  if (/[\n\r]/.test(v)) return JSON.stringify(v)
  if (/(:\s)|(:$)|(\s#)/.test(v)) return JSON.stringify(v)
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) return JSON.stringify(v)
  return v
}
