/**
 * Retry primitives — exponential backoff with full jitter, predicate-driven
 * retryability, and configurable budget.
 *
 * Used by every network-touching client in the codebase: embedder (Ollama,
 * OpenAI), HTTP reranker, Anthropic consolidator. Centralised here so the
 * backoff curve and "what counts as retryable" stay consistent.
 *
 * Backoff schedule (default):
 *   attempt 1: immediate
 *   attempt 2: random in [0, baseDelayMs)
 *   attempt 3: random in [0, 2 * baseDelayMs)
 *   attempt 4: random in [0, 4 * baseDelayMs)
 *   ...capped at maxDelayMs
 *
 * Jitter strategy: full jitter (Marc Brooker's recommendation in
 * "Exponential Backoff and Jitter", AWS Architecture blog) — minimises
 * thundering-herd at the cost of slightly higher tail latency than
 * decorrelated jitter.
 */

import { createLogger } from './logger.js'

const log = createLogger('retry')

export interface RetryOptions {
  /** Maximum number of attempts including the first. Default 3. */
  maxAttempts?: number
  /** Base delay in ms for backoff. Default 200. */
  baseDelayMs?: number
  /** Cap on delay between retries. Default 5000. */
  maxDelayMs?: number
  /**
   * Predicate that decides whether an error is retryable. Default: retry on
   * network errors + 5xx + 408/429. Non-retryable errors propagate
   * immediately so the caller doesn't wait through pointless retries on a
   * 401/403.
   */
  isRetryable?: (err: unknown, attempt: number) => boolean
  /** Optional name for logs. */
  label?: string
  /** AbortSignal for cancellation. */
  signal?: AbortSignal
}

export class RetryAbortError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'retry aborted')
    this.name = 'RetryAbortError'
  }
}

/**
 * Run `fn` with exponential backoff. Returns the first successful value or
 * rethrows the last error after the budget is exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const baseDelayMs = opts.baseDelayMs ?? 200
  const maxDelayMs = opts.maxDelayMs ?? 5000
  const isRetryable = opts.isRetryable ?? defaultIsRetryable
  const label = opts.label ?? 'unlabelled'

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new RetryAbortError(opts.signal.reason as string | undefined)
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts) break
      if (!isRetryable(err, attempt)) break

      const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs)
      log.debug('retrying', {
        label,
        attempt,
        next_delay_ms: delay,
        error: (err as Error).message ?? String(err),
      })
      await sleep(delay, opts.signal)
    }
  }
  throw lastError
}

/**
 * Full-jitter exponential backoff: delay = random in [0, min(maxDelayMs,
 * baseDelayMs * 2^(attempt-1))).
 */
export function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1))
  return Math.floor(Math.random() * exp)
}

/**
 * Default retryable predicate. Treats these as retryable:
 *   - network failures (ECONNRESET, ETIMEDOUT, ECONNREFUSED, EAI_AGAIN, ...)
 *   - HTTP 408 (Request Timeout)
 *   - HTTP 429 (Too Many Requests)
 *   - HTTP 5xx
 *   - Errors whose message contains "timeout", "fetch failed", "socket hang up"
 *
 * Treats these as NOT retryable:
 *   - HTTP 4xx (except 408 / 429)
 *   - Generic application errors with no retryable signal
 */
export function defaultIsRetryable(err: unknown, _attempt: number): boolean {
  if (!err) return false
  if (isNetworkError(err)) return true

  const status = extractHttpStatus(err)
  if (status !== null) {
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) return true
    if (status >= 400 && status < 500) return false
  }

  const msg = String((err as Error).message ?? err)
  return /timeout|fetch failed|socket hang up|aborted/i.test(msg)
}

/**
 * Extract a 3-digit HTTP status from a thrown Error's message. Clients in
 * this repo throw with the status embedded in the text (e.g.
 * "ollama embed 503: down", "rerank http 429: rate limited"). Returns null
 * when no status is detectable.
 */
export function extractHttpStatus(err: unknown): number | null {
  const msg = String((err as Error).message ?? err)
  const m = /\b(\d{3})\b/.exec(msg)
  return m ? Number(m[1]) : null
}

/** True for the network-level error codes from undici / Node fetch / pg. */
export function isNetworkError(err: unknown): boolean {
  const code = (err as { code?: string }).code
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortError(signal.reason as string | undefined))
      return
    }
    const t = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new RetryAbortError(signal?.reason as string | undefined))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    function cleanup(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
    }
  })
}
