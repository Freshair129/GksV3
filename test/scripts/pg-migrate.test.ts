/**
 * pg-migrate.ts ships only behind a CLI; here we sanity-check the SQL
 * template substitution that drives it. Real-DB integration is exercised
 * via docker-compose (out of scope for unit tests).
 */

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const SQL_PATH = resolve(__dirname, '..', '..', 'src', 'memory', 'vector', 'pgvector.sql')

function substitute(raw: string, table: string, dim: number): string {
  return raw.replace(/\{\{table\}\}/g, table).replace(/\{\{dim\}\}/g, String(dim))
}

describe('pgvector schema template', () => {
  it('every {{table}} placeholder is replaced (and quoted)', async () => {
    const raw = await readFile(SQL_PATH, 'utf8')
    const out = substitute(raw, 'gks_vector', 1024)
    expect(out).not.toContain('{{table}}')
    expect(out).not.toContain('{{dim}}')
    expect(out).toContain('"gks_vector"')
    // manifest table is derived, not templated separately
    expect(out).toContain('"gks_vector_manifest"')
  })

  it('vector dimension is interpolated', async () => {
    const raw = await readFile(SQL_PATH, 'utf8')
    const out = substitute(raw, 'gks_vector', 1024)
    expect(out).toMatch(/vector\(1024\)/)
  })

  it('declares HNSW with cosine distance', async () => {
    const raw = await readFile(SQL_PATH, 'utf8')
    expect(raw).toMatch(/USING hnsw \(vector vector_cosine_ops\)/)
    expect(raw).toMatch(/m\s*=\s*16/)
    expect(raw).toMatch(/ef_construction\s*=\s*64/)
  })

  it('uses CREATE ... IF NOT EXISTS for every object (idempotent)', async () => {
    const raw = await readFile(SQL_PATH, 'utf8')
    const creates = [...raw.matchAll(/CREATE\s+(EXTENSION|TABLE|INDEX)/gi)]
    for (const m of creates) {
      // Look at a 60-char window after the CREATE keyword to find IF NOT EXISTS.
      const window = raw.slice(m.index!, m.index! + 80)
      expect(window).toMatch(/IF NOT EXISTS/i)
    }
  })

  it('manifest table holds embedder model + file_hashes columns', async () => {
    const raw = await readFile(SQL_PATH, 'utf8')
    expect(raw).toMatch(/embedder_model\s+text/)
    expect(raw).toMatch(/dimension\s+int/)
    expect(raw).toMatch(/file_hashes\s+jsonb/)
  })
})
