#!/usr/bin/env tsx
/**
 * pg-migrate — apply the pgvector schema (idempotent).
 *
 * Reads src/memory/vector/pgvector.sql, substitutes {{table}} / {{dim}}
 * placeholders, and runs the result through psql-equivalent via the `pg`
 * client. Safe to re-run; uses CREATE EXTENSION IF NOT EXISTS, CREATE TABLE
 * IF NOT EXISTS, CREATE INDEX IF NOT EXISTS throughout.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run pg-migrate
 *   npm run pg-migrate -- --dim=1024 --table=gks_vector
 *   npm run pg-migrate -- --drop          # tear down (dev only)
 *
 * Environment
 *   DATABASE_URL    pg connection string (required if no --url flag)
 *   GKS_VECTOR_DIM  default vector dimension (default: 1024 for bge-m3)
 *   GKS_VECTOR_TABLE  default table name (default: gks_vector)
 */

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'

import { createLogger } from '../../src/lib/logger.js'

const log = createLogger('script:pg-migrate')

interface Options {
  url: string
  table: string
  dim: number
  drop: boolean
  verify: boolean
}

async function main(): Promise<void> {
  const opts = parseOptions()

  const client = new pg.Client({ connectionString: opts.url })
  await client.connect()
  try {
    if (opts.drop) {
      await dropSchema(client, opts.table)
      log.info('schema dropped', { table: opts.table })
      return
    }

    const sql = await loadSchema(opts.table, opts.dim)
    log.info('applying schema', { table: opts.table, dim: opts.dim })
    await client.query(sql)

    if (opts.verify) {
      await verifySchema(client, opts.table)
    }

    log.info('migration complete', { table: opts.table })
    console.log(
      JSON.stringify(
        { ok: true, table: opts.table, manifest_table: `${opts.table}_manifest`, dim: opts.dim },
        null,
        2,
      ),
    )
  } finally {
    await client.end()
  }
}

async function loadSchema(table: string, dim: number): Promise<string> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`pg-migrate: invalid table name '${table}'`)
  }
  if (!Number.isInteger(dim) || dim < 1 || dim > 16000) {
    throw new Error(`pg-migrate: invalid dim ${dim} (must be integer 1..16000)`)
  }
  // Resolve relative to this script's directory so the binary works wherever
  // the user runs it from.
  const here = dirname(fileURLToPath(import.meta.url))
  const sqlPath = resolve(here, '..', '..', 'src', 'memory', 'vector', 'pgvector.sql')
  const raw = await readFile(sqlPath, 'utf8')
  return raw.replace(/\{\{table\}\}/g, table).replace(/\{\{dim\}\}/g, String(dim))
}

async function verifySchema(client: pg.Client, table: string): Promise<void> {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`,
    [table],
  )
  const n = (result.rows[0] as { n: number }).n
  if (n === 0) {
    throw new Error(`pg-migrate: verification failed — table '${table}' not found after CREATE`)
  }

  // Confirm the HNSW index exists (otherwise queries will fall back to seq scan).
  const idx = await client.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname LIKE '%_hnsw_%'`,
    [table],
  )
  if (idx.rows.length === 0) {
    log.warn('HNSW index missing — searches will be slow', { table })
  }
}

async function dropSchema(client: pg.Client, table: string): Promise<void> {
  // Validation guards against injection via env / CLI even though we already
  // checked at parse time.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`pg-migrate: invalid table name '${table}'`)
  }
  await client.query(`DROP TABLE IF EXISTS "${table}_manifest"`)
  await client.query(`DROP TABLE IF EXISTS "${table}"`)
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: 'string' },
      table: { type: 'string' },
      dim: { type: 'string' },
      drop: { type: 'boolean' },
      verify: { type: 'boolean' },
    },
  })

  const url = (values.url as string | undefined) ?? process.env['DATABASE_URL']
  if (!url) {
    log.error('connection string required: pass --url=... or set DATABASE_URL')
    process.exit(2)
  }

  return {
    url,
    table: (values.table as string | undefined) ?? process.env['GKS_VECTOR_TABLE'] ?? 'gks_vector',
    dim: Number(values.dim ?? process.env['GKS_VECTOR_DIM'] ?? 1024),
    drop: values.drop === true,
    verify: values.verify !== false,
  }
}

main().catch((err) => {
  log.error('pg-migrate failed', { err: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
