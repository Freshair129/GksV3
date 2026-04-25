/**
 * Schema versioning for GKS persistent stores.
 *
 * Versions follow semver. Compatibility policy on load():
 *   - same major  : compatible (proceed)
 *   - lower major : refuse, instruct user to run migration
 *   - higher major: refuse — store is from a newer GKS than this code
 *
 * The runtime `CURRENT_SCHEMA_VERSION` is bumped here whenever the
 * on-disk format changes. Stores without a `schema_version` field at all
 * are treated as v1.0.0 (the original Phase 1 layout), which is
 * forward-compatible with the current schema (only added fields, never
 * renamed).
 */

export const CURRENT_SCHEMA_VERSION = '1.0.0'

export type Compatibility =
  | { kind: 'same' }
  | { kind: 'minor_upgrade'; from: string; to: string }
  | { kind: 'patch_upgrade'; from: string; to: string }
  | { kind: 'incompatible_major'; from: string; to: string }
  | { kind: 'newer_than_runtime'; from: string; to: string }
  | { kind: 'unknown'; from: string; to: string }

export class SchemaVersionMismatchError extends Error {
  readonly from: string
  readonly to: string
  readonly kind: Compatibility['kind']
  constructor(kind: Compatibility['kind'], from: string, to: string) {
    super(formatMessage(kind, from, to))
    this.name = 'SchemaVersionMismatchError'
    this.kind = kind
    this.from = from
    this.to = to
  }
}

/**
 * Compare an on-disk schema version against the current runtime version.
 * Pass `undefined` for stores that predate versioning — treated as 1.0.0.
 */
export function checkSchemaCompatibility(
  onDisk: string | undefined,
  current: string = CURRENT_SCHEMA_VERSION,
): Compatibility {
  const from = onDisk ?? '1.0.0'
  if (from === current) return { kind: 'same' }
  const f = parse(from)
  const c = parse(current)
  if (!f || !c) return { kind: 'unknown', from, to: current }

  if (f.major === c.major) {
    if (f.minor < c.minor) return { kind: 'minor_upgrade', from, to: current }
    if (f.minor > c.minor) return { kind: 'newer_than_runtime', from, to: current }
    if (f.patch < c.patch) return { kind: 'patch_upgrade', from, to: current }
    if (f.patch > c.patch) return { kind: 'newer_than_runtime', from, to: current }
    return { kind: 'same' }
  }

  if (f.major > c.major) return { kind: 'newer_than_runtime', from, to: current }
  return { kind: 'incompatible_major', from, to: current }
}

/**
 * Apply the policy described in CURRENT_SCHEMA_VERSION:
 *   incompatible_major | newer_than_runtime → throw
 *   minor_upgrade | patch_upgrade           → return (caller may log)
 *   same | unknown                          → return
 */
export function enforceSchemaCompatibility(
  onDisk: string | undefined,
  current: string = CURRENT_SCHEMA_VERSION,
): Compatibility {
  const cmp = checkSchemaCompatibility(onDisk, current)
  if (cmp.kind === 'incompatible_major' || cmp.kind === 'newer_than_runtime') {
    throw new SchemaVersionMismatchError(cmp.kind, cmp.from, cmp.to)
  }
  return cmp
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

function parse(v: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function formatMessage(kind: Compatibility['kind'], from: string, to: string): string {
  if (kind === 'incompatible_major') {
    return (
      `schema ${from} on disk vs runtime ${to} (major mismatch). ` +
      `Run 'npm run gks-migrate -- --from=${from} --to=${to}' to upgrade.`
    )
  }
  if (kind === 'newer_than_runtime') {
    return (
      `schema ${from} on disk is newer than runtime ${to}. ` +
      `Upgrade GKS to load this store, or use --force to read on a best-effort basis.`
    )
  }
  return `schema mismatch: ${from} → ${to}`
}
