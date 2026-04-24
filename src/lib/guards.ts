/**
 * Runtime type guards + small value coercions.
 *
 * Extracted because these were re-declared in four places (benchmarks/*.ts,
 * consolidator-llm.ts). Colocating them means a typo-fix in one lands in all
 * callers automatically.
 */

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export function isPresent<T>(x: T | null | undefined): x is T {
  return x != null
}

/** Keep only the `string` elements from an unknown iterable. */
export function toStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return []
  return x.filter((v): v is string => typeof v === 'string')
}

/** Pick the first array-valued property from `obj` whose key is in `keys`. */
export function pickArray(obj: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(obj)) return obj
  if (!isRecord(obj)) return []
  for (const k of keys) {
    const v = obj[k]
    if (Array.isArray(v)) return v
  }
  return []
}
