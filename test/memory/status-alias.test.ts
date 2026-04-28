/**
 * Status alias tests (ADR-014 item 2).
 */

import { describe, it, expect } from 'vitest'
import { normaliseStatus, isApprovedStatus } from '../../src/memory/types.js'

describe('normaliseStatus', () => {
  it('maps APPROVED / accepted to stable', () => {
    expect(normaliseStatus('APPROVED')).toBe('stable')
    expect(normaliseStatus('approved')).toBe('stable')
    expect(normaliseStatus('Accepted')).toBe('stable')
  })

  it('lowercases and trims unrecognised values', () => {
    expect(normaliseStatus('  Draft ')).toBe('draft')
    expect(normaliseStatus('STABLE')).toBe('stable')
    expect(normaliseStatus('weird-value')).toBe('weird-value')
  })

  it('returns undefined for null / undefined input', () => {
    expect(normaliseStatus(undefined)).toBeUndefined()
    expect(normaliseStatus(null)).toBeUndefined()
  })
})

describe('isApprovedStatus', () => {
  it('accepts stable / approved / accepted (any case)', () => {
    expect(isApprovedStatus('stable')).toBe(true)
    expect(isApprovedStatus('APPROVED')).toBe(true)
    expect(isApprovedStatus('Accepted')).toBe(true)
  })

  it('rejects every other status', () => {
    for (const s of ['raw', 'draft', 'deprecated', 'invalid', 'proposed', 'rejected', '', 'APPROVE']) {
      expect(isApprovedStatus(s)).toBe(false)
    }
    expect(isApprovedStatus(undefined)).toBe(false)
    expect(isApprovedStatus(null)).toBe(false)
  })
})
