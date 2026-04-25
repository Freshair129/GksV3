/**
 * Circuit breaker — prevents wasted retries against a known-broken upstream.
 *
 * Three states (Hystrix-style):
 *   CLOSED     — normal operation. Counts consecutive failures.
 *   OPEN       — short-circuited. All calls fail fast for `cooldownMs`.
 *   HALF_OPEN  — single trial call after cooldown. Success → CLOSED, failure → OPEN.
 *
 * The breaker pairs naturally with src/lib/retry.ts: retry handles transient
 * blips inside a single request; the breaker prevents a long string of
 * retries when the upstream has been down for a sustained period.
 *
 * Used by Embedder.createEmbedder() to flip Ollama → OpenAI fallback after
 * Ollama trips its breaker, without re-probing on every embed call.
 */

import { createLogger } from './logger.js'

const log = createLogger('circuit')

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  /** Failures in a row before tripping. Default 5. */
  failureThreshold?: number
  /** ms to stay OPEN before allowing a half-open trial. Default 30000. */
  cooldownMs?: number
  /** Optional name for logs. */
  name?: string
  /** Custom failure predicate — by default any thrown error counts. */
  isFailure?: (err: unknown) => boolean
  /** Clock injection for tests. */
  now?: () => number
}

export class CircuitBreakerOpenError extends Error {
  readonly retryAfterMs: number
  constructor(name: string, retryAfterMs: number) {
    super(`circuit '${name}' is OPEN (retry in ${retryAfterMs}ms)`)
    this.name = 'CircuitBreakerOpenError'
    this.retryAfterMs = retryAfterMs
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private consecutiveFailures = 0
  private nextAttemptAt = 0
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly isFailure: (err: unknown) => boolean
  private readonly now: () => number
  private readonly name: string

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 5)
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 30_000)
    this.isFailure = opts.isFailure ?? (() => true)
    this.now = opts.now ?? Date.now
    this.name = opts.name ?? 'unnamed'
  }

  /**
   * Run `fn` under the breaker. Throws CircuitBreakerOpenError without
   * invoking `fn` if the breaker is currently OPEN; otherwise behaves as a
   * pass-through that updates state on success/failure.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const remaining = this.nextAttemptAt - this.now()
      if (remaining > 0) {
        throw new CircuitBreakerOpenError(this.name, remaining)
      }
      // Cooldown expired — allow one trial.
      this.transitionTo('half_open')
    }

    try {
      const result = await fn()
      this.recordSuccess()
      return result
    } catch (err) {
      if (this.isFailure(err)) this.recordFailure()
      throw err
    }
  }

  getState(): CircuitState {
    if (this.state === 'open' && this.now() >= this.nextAttemptAt) return 'half_open'
    return this.state
  }

  /** Force-close (e.g. after manual intervention). Used by tests + admin tools. */
  reset(): void {
    this.transitionTo('closed')
    this.consecutiveFailures = 0
    this.nextAttemptAt = 0
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0
    if (this.state !== 'closed') {
      this.transitionTo('closed')
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.state === 'half_open') {
      // Trial failed → re-open with a fresh cooldown.
      this.tripOpen()
      return
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.tripOpen()
    }
  }

  private tripOpen(): void {
    this.nextAttemptAt = this.now() + this.cooldownMs
    this.transitionTo('open')
  }

  private transitionTo(state: CircuitState): void {
    if (this.state === state) return
    log.info('circuit transition', {
      name: this.name,
      from: this.state,
      to: state,
      consecutive_failures: this.consecutiveFailures,
    })
    this.state = state
  }
}
