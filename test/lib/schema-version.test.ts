import { describe, it, expect } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  SchemaVersionMismatchError,
  checkSchemaCompatibility,
  enforceSchemaCompatibility,
} from '../../src/lib/schema-version.js'

describe('checkSchemaCompatibility', () => {
  it('treats undefined on-disk version as v1.0.0', () => {
    expect(checkSchemaCompatibility(undefined, '1.0.0').kind).toBe('same')
    expect(checkSchemaCompatibility(undefined, '1.0.1').kind).toBe('patch_upgrade')
    expect(checkSchemaCompatibility(undefined, '2.0.0').kind).toBe('incompatible_major')
  })

  it('returns same when versions match exactly', () => {
    expect(checkSchemaCompatibility('1.2.3', '1.2.3').kind).toBe('same')
  })

  it('returns minor_upgrade for higher minor in same major', () => {
    expect(checkSchemaCompatibility('1.0.0', '1.1.0').kind).toBe('minor_upgrade')
    expect(checkSchemaCompatibility('1.0.5', '1.2.0').kind).toBe('minor_upgrade')
  })

  it('returns patch_upgrade for higher patch in same minor', () => {
    expect(checkSchemaCompatibility('1.0.0', '1.0.5').kind).toBe('patch_upgrade')
  })

  it('returns incompatible_major across major boundaries', () => {
    expect(checkSchemaCompatibility('1.0.0', '2.0.0').kind).toBe('incompatible_major')
    expect(checkSchemaCompatibility('1.5.7', '2.0.0').kind).toBe('incompatible_major')
  })

  it('returns newer_than_runtime when on-disk is ahead of runtime', () => {
    expect(checkSchemaCompatibility('2.0.0', '1.0.0').kind).toBe('newer_than_runtime')
    expect(checkSchemaCompatibility('1.5.0', '1.4.0').kind).toBe('newer_than_runtime')
    expect(checkSchemaCompatibility('1.0.5', '1.0.0').kind).toBe('newer_than_runtime')
  })

  it('returns unknown for unparseable versions', () => {
    expect(checkSchemaCompatibility('not-a-semver', '1.0.0').kind).toBe('unknown')
  })
})

describe('enforceSchemaCompatibility', () => {
  it('throws on incompatible_major', () => {
    expect(() => enforceSchemaCompatibility('1.0.0', '2.0.0')).toThrow(SchemaVersionMismatchError)
  })

  it('throws on newer_than_runtime', () => {
    expect(() => enforceSchemaCompatibility('2.0.0', '1.0.0')).toThrow(/newer than runtime/)
  })

  it('passes through on minor_upgrade / patch_upgrade / same', () => {
    expect(enforceSchemaCompatibility('1.0.0', '1.1.0').kind).toBe('minor_upgrade')
    expect(enforceSchemaCompatibility('1.0.0', '1.0.1').kind).toBe('patch_upgrade')
    expect(enforceSchemaCompatibility('1.0.0', '1.0.0').kind).toBe('same')
  })

  it('error message points at the migration command', () => {
    try {
      enforceSchemaCompatibility('1.0.0', '2.0.0')
    } catch (err) {
      expect((err as Error).message).toMatch(/npm run gks-migrate/)
    }
  })
})

describe('CURRENT_SCHEMA_VERSION', () => {
  it('is a parseable semver', () => {
    expect(CURRENT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
