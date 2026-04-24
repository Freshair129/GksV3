/**
 * Text normalization + token / snippet utilities.
 *
 * Centralized here because these were duplicated (with subtle divergences)
 * across benchmarks/, obsidian-mcp.ts, and rerank.ts. Keeping a single
 * normalizer means the Jaccard threshold in text matchers stays consistent
 * wherever it's applied.
 */

/**
 * Lowercase, strip punctuation, collapse whitespace. Unicode-aware: keeps
 * letters/numbers across scripts (Thai + CJK + Latin), drops everything else.
 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Split into lowercase "words" of length ≥ 2. Used by BM25 and Jaccard.
 * Callers that want stopword removal layer it on top.
 */
export function tokenize(s: string): string[] {
  return normalizeText(s).split(' ').filter((t) => t.length > 1)
}

/**
 * Fuzzy substring match: returns true when `needle` is a substring of
 * `haystack` after normalization, OR when they share ≥ 60% of their
 * (length-gated) token set (Jaccard).
 */
export function containsSnippet(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack)
  const n = normalizeText(needle)
  if (!n) return false
  if (h.includes(n)) return true
  const hw = new Set(h.split(' ').filter((w) => w.length > 2))
  const nw = new Set(n.split(' ').filter((w) => w.length > 2))
  if (nw.size === 0) return false
  let overlap = 0
  for (const w of nw) if (hw.has(w)) overlap += 1
  const union = new Set([...hw, ...nw]).size
  return overlap / union >= 0.6
}

/** Clip a string to `max` with an ellipsis. `collapse` flattens whitespace first. */
export function truncate(s: string, max: number, opts: { collapse?: boolean } = {}): string {
  const src = opts.collapse ? s.replace(/\s+/g, ' ').trim() : s
  return src.length <= max ? src : src.slice(0, max - 1) + '…'
}
