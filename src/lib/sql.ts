/**
 * Postgres helpers shared between the pgvector + pg-graph backends and the
 * pg-migrate runner.
 *
 * Centralized here because three call sites had:
 *   - identifier-validation regexes with subtle wording differences in
 *     their error messages,
 *   - a copy of the BEGIN / COMMIT / ROLLBACK transaction scaffold (the
 *     `.catch(() => {})` swallow on rollback is intentional — without it,
 *     a rollback failure would mask the original error).
 *   - the same 42P01 (undefined_table) error-code check.
 *
 * One source for all of them, no behavior change.
 */

import type { Pool, PoolClient } from 'pg'

/**
 * Validate a Postgres identifier against the conservative whitelist used
 * across the codebase: must start with a letter or underscore, then
 * letters / digits / underscore. No quoting needed inside SQL — but we
 * still wrap in double quotes for case-preservation + uniformity.
 *
 * Throws if the identifier is unsafe; otherwise returns `"name"`.
 */
export function quoteIdent(name: string, ctx = 'sql'): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`${ctx}: invalid identifier '${name}' — letters/digits/underscore only`)
  }
  return `"${name}"`
}

/**
 * Run `fn` inside a Postgres transaction. Acquires a connection from the
 * pool, BEGIN-runs-COMMIT on success or ROLLBACK on throw, releases the
 * client in finally. The .catch(() => {}) on ROLLBACK is intentional —
 * without it a rollback failure would mask the original error the caller
 * cares about.
 */
export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * `42P01` = undefined_table. Tells callers the migration hasn't been
 * applied yet so they can throw a friendly "run npm run pg-migrate"
 * message instead of a generic SQL error.
 */
export function isMissingTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '42P01'
  )
}

/**
 * Per the Postgres COPY text-format spec: backslash, tab, newline, and
 * carriage return need escaping. (NULL is also configurable but our COPY
 * uses the default `\\N`, so producers don't need a special case.)
 *
 * Used by pgvector.copyInDocs(); generic enough to live here for the next
 * backend that wants COPY-in.
 */
/**
 * Coerce a numeric LIMIT/OFFSET to a safe positive integer. Postgres doesn't
 * accept parameters in `LIMIT` in all dialects we target, so values are
 * string-interpolated. `Math.floor` of a finite Number cannot produce a
 * SQL-injectable string, but NaN / Infinity / negative input would either
 * break SQL parsing or trigger pathological scans — clamp to a sane range.
 */
export function safeLimit(n: number, opts: { default: number; max?: number }): number {
  const max = opts.max ?? 100_000
  if (!Number.isFinite(n)) return opts.default
  return Math.min(max, Math.max(1, Math.floor(n)))
}

export function escapeCopyField(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}
