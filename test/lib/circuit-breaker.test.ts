import { describe, it, expect } from 'vitest'
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../../src/lib/circuit-breaker.js'

/**
 * Helper that creates a breaker driven by a virtual clock so we don't have
 * to actually wait through cooldowns in CI.
 */
function clockedBreaker(opts: ConstructorParameters<typeof CircuitBreaker>[0] = {}) {
  let now = 0
  return {
    breaker: new CircuitBreaker({ ...opts, now: () => now }),
    advance: (ms: number) => {
      now += ms
    },
    setNow: (t: number) => {
      now = t
    },
  }
}

describe('CircuitBreaker', () => {
  it('passes calls through when closed', async () => {
    const { breaker } = clockedBreaker()
    expect(await breaker.exec(async () => 42)).toBe(42)
    expect(breaker.getState()).toBe('closed')
  })

  it('trips OPEN after failureThreshold consecutive failures', async () => {
    const { breaker } = clockedBreaker({ failureThreshold: 3, cooldownMs: 1000 })
    const failingFn = async () => {
      throw new Error('boom')
    }

    for (let i = 0; i < 3; i++) {
      await expect(breaker.exec(failingFn)).rejects.toThrow(/boom/)
    }
    expect(breaker.getState()).toBe('open')

    // Subsequent call short-circuits without invoking the function.
    let invoked = false
    await expect(
      breaker.exec(async () => {
        invoked = true
        return 1
      }),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError)
    expect(invoked).toBe(false)
  })

  it('resets the failure counter on a single success', async () => {
    const { breaker } = clockedBreaker({ failureThreshold: 3, cooldownMs: 1000 })
    const failing = async () => {
      throw new Error('boom')
    }
    await expect(breaker.exec(failing)).rejects.toThrow()
    await expect(breaker.exec(failing)).rejects.toThrow()
    await breaker.exec(async () => 'ok')
    // After 1 success, fresh streak — needs 3 more failures to trip.
    await expect(breaker.exec(failing)).rejects.toThrow()
    await expect(breaker.exec(failing)).rejects.toThrow()
    expect(breaker.getState()).toBe('closed')
  })

  it('moves to HALF_OPEN after cooldown elapses', async () => {
    const { breaker, advance } = clockedBreaker({ failureThreshold: 1, cooldownMs: 1000 })
    await expect(breaker.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(breaker.getState()).toBe('open')

    advance(500)
    expect(breaker.getState()).toBe('open')

    advance(500)
    // exec call right after cooldown allows the trial through.
    let trialRan = false
    const out = await breaker.exec(async () => {
      trialRan = true
      return 'trial'
    })
    expect(trialRan).toBe(true)
    expect(out).toBe('trial')
    expect(breaker.getState()).toBe('closed')
  })

  it('failed trial in HALF_OPEN re-opens with a fresh cooldown', async () => {
    const { breaker, advance } = clockedBreaker({ failureThreshold: 1, cooldownMs: 1000 })

    await expect(breaker.exec(async () => Promise.reject(new Error('first')))).rejects.toThrow()
    advance(1100)

    // Trial fails → re-OPEN.
    await expect(breaker.exec(async () => Promise.reject(new Error('trial-fail')))).rejects.toThrow(
      /trial-fail/,
    )
    expect(breaker.getState()).toBe('open')

    // Even right after the trial, the breaker must wait the full cooldownMs again.
    advance(500)
    await expect(breaker.exec(async () => 'wont-run')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
  })

  it('honors a custom isFailure predicate (e.g. ignore 4xx)', async () => {
    const { breaker } = clockedBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      isFailure: (err) => !/4\d{2}/.test((err as Error).message),
    })

    // 4xx errors don't count toward the failure budget.
    for (let i = 0; i < 5; i++) {
      await expect(breaker.exec(async () => Promise.reject(new Error('client 400')))).rejects.toThrow()
    }
    expect(breaker.getState()).toBe('closed')

    // 5xx counts.
    await expect(breaker.exec(async () => Promise.reject(new Error('server 500')))).rejects.toThrow()
    await expect(breaker.exec(async () => Promise.reject(new Error('server 503')))).rejects.toThrow()
    expect(breaker.getState()).toBe('open')
  })

  it('reset() force-closes the breaker', async () => {
    const { breaker } = clockedBreaker({ failureThreshold: 1, cooldownMs: 5000 })
    await expect(breaker.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(breaker.getState()).toBe('open')

    breaker.reset()
    expect(breaker.getState()).toBe('closed')
    expect(await breaker.exec(async () => 7)).toBe(7)
  })

  it('CircuitBreakerOpenError carries retryAfterMs', async () => {
    const { breaker, advance } = clockedBreaker({ failureThreshold: 1, cooldownMs: 5000 })
    await expect(breaker.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow()
    advance(2000)

    await breaker.exec(async () => 'ok').catch((err) => {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError)
      expect((err as CircuitBreakerOpenError).retryAfterMs).toBe(3000)
    })
  })
})
