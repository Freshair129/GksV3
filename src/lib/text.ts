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

/**
 * Best-effort redaction of credential-shaped substrings before they land in
 * thrown errors / log lines / OTel spans. Provider error bodies sometimes
 * echo back the request (incl. Authorization headers); we mask those before
 * propagation so a 500 from upstream can't leak our key into Sentry/etc.
 *
 * Patterns redacted: Bearer tokens, x-api-key headers, "api_key=...", raw
 * provider key prefixes (sk-, sk-ant-, xoxb-, ghp_), and obvious JWT shapes.
 */
export function redactSecrets(s: string): string {
  if (!s) return s
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/(x-api-key|authorization)\s*[:=]\s*[A-Za-z0-9._\-+/=]{8,}/gi, '$1: [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret)\b\s*[:=]\s*"?[A-Za-z0-9._\-+/=]{8,}"?/gi, '$1=[REDACTED]')
    .replace(/\bsk-(ant-)?[A-Za-z0-9_\-]{16,}/g, 'sk-[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]')
    .replace(/\bghp_[A-Za-z0-9]{16,}/g, 'ghp_[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '[JWT-REDACTED]')
}
