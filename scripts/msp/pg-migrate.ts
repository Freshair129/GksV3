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

type SchemaName = 'vector' | 'graph' | 'all'

interface Options {
  url: string
  table: string
  graphTable: string
  dim: number
  schema: SchemaName
  drop: boolean
  verify: boolean
}

async function main(): Promise<void> {
  const opts = parseOptions()

  const client = new pg.Client({ connectionString: opts.url })
  await client.connect()
  try {
    if (opts.drop) {
      if (opts.schema === 'vector' || opts.schema === 'all') {
        await dropVectorSchema(client, opts.table)
        log.info('vector schema dropped', { table: opts.table })
      }
      if (opts.schema === 'graph' || opts.schema === 'all') {
        await dropGraphSchema(client, opts.graphTable)
        log.info('graph schema dropped', { table: opts.graphTable })
      }
      return
    }

    const applied: string[] = []
    if (opts.schema === 'vector' || opts.schema === 'all') {
      const sql = await loadSchemaFile('pgvector.sql', opts.table, opts.dim)
      log.info('applying vector schema', { table: opts.table, dim: opts.dim })
      await client.query(sql)
      applied.push('vector')
    }
    if (opts.schema === 'graph' || opts.schema === 'all') {
      const sql = await loadGraphSchemaFile(opts.graphTable)
      log.info('applying graph schema', { table: opts.graphTable })
      await client.query(sql)
      applied.push('graph')
    }

    if (opts.verify) {
      if (applied.includes('vector')) await verifyVectorSchema(client, opts.table)
      if (applied.includes('graph')) await verifyGraphSchema(client, opts.graphTable)
    }

    log.info('migration complete', { applied })
    console.log(
      JSON.stringify(
        {
          ok: true,
          applied,
          ...(applied.includes('vector')
            ? { vector_table: opts.table, manifest_table: `${opts.table}_manifest`, dim: opts.dim }
            : {}),
          ...(applied.includes('graph')
            ? { graph_node_table: `${opts.graphTable}_node`, graph_edge_table: `${opts.graphTable}_edge` }
            : {}),
        },
        null,
        2,
      ),
    )
  } finally {
    await client.end()
  }
}

async function loadSchemaFile(filename: string, table: string, dim?: number): Promise<string> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`pg-migrate: invalid table name '${table}'`)
  }
  if (dim !== undefined && (!Number.isInteger(dim) || dim < 1 || dim > 16000)) {
    throw new Error(`pg-migrate: invalid dim ${dim} (must be integer 1..16000)`)
  }
  // Resolve relative to this script's directory so it works wherever the
  // user runs it from.
  const here = dirname(fileURLToPath(import.meta.url))
  const sqlPath = resolve(here, '..', '..', 'src', 'memory', 'vector', filename)
  const raw = await readFile(sqlPath, 'utf8')
  let out = raw.replace(/\{\{table\}\}/g, table)
  if (dim !== undefined) out = out.replace(/\{\{dim\}\}/g, String(dim))
  return out
}

async function loadGraphSchemaFile(table: string): Promise<string> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`pg-migrate: invalid graph table name '${table}'`)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const sqlPath = resolve(here, '..', '..', 'src', 'memory', 'graph', 'pg.sql')
  const raw = await readFile(sqlPath, 'utf8')
  return raw.replace(/\{\{table\}\}/g, table)
}

async function verifyVectorSchema(client: pg.Client, table: string): Promise<void> {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`,
    [table],
  )
  const n = (result.rows[0] as { n: number }).n
  if (n === 0) {
    throw new Error(`pg-migrate: verification failed — table '${table}' not found after CREATE`)
  }
  const idx = await client.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname LIKE '%_hnsw_%'`,
    [table],
  )
  if (idx.rows.length === 0) {
    log.warn('HNSW index missing — searches will be slow', { table })
  }
}

async function verifyGraphSchema(client: pg.Client, table: string): Promise<void> {
  for (const sub of ['_node', '_edge']) {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`,
      [`${table}${sub}`],
    )
    const n = (result.rows[0] as { n: number }).n
    if (n === 0) {
      throw new Error(`pg-migrate: verification failed — table '${table}${sub}' not found`)
    }
  }
  const gistIdx = await client.query(
    `SELECT indexname FROM pg_indexes
       WHERE tablename = $1 AND indexname LIKE '%_valid_idx'`,
    [`${table}_edge`],
  )
  if (gistIdx.rows.length === 0) {
    log.warn('graph valid-range GiST index missing — temporal queries will be slow', { table })
  }
}

async function dropVectorSchema(client: pg.Client, table: string): Promise<void> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`pg-migrate: invalid table name '${table}'`)
  }
  await client.query(`DROP TABLE IF EXISTS "${table}_manifest"`)
  await client.query(`DROP TABLE IF EXISTS "${table}"`)
}

async function dropGraphSchema(client: pg.Client, table: string): Promise<void> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`pg-migrate: invalid graph table name '${table}'`)
  }
  // Edge first (it FKs node).
  await client.query(`DROP TABLE IF EXISTS "${table}_edge"`)
  await client.query(`DROP TABLE IF EXISTS "${table}_node"`)
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: 'string' },
      table: { type: 'string' },
      'graph-table': { type: 'string' },
      schema: { type: 'string' },
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

  const schemaRaw = (values['schema'] as string | undefined) ?? 'all'
  if (schemaRaw !== 'vector' && schemaRaw !== 'graph' && schemaRaw !== 'all') {
    log.error(`invalid --schema='${schemaRaw}' (expected: vector | graph | all)`)
    process.exit(2)
  }

  return {
    url,
    table: (values.table as string | undefined) ?? process.env['GKS_VECTOR_TABLE'] ?? 'gks_vector',
    graphTable:
      (values['graph-table'] as string | undefined) ?? process.env['GKS_GRAPH_TABLE'] ?? 'gks_graph',
    dim: Number(values.dim ?? process.env['GKS_VECTOR_DIM'] ?? 1024),
    schema: schemaRaw as SchemaName,
    drop: values.drop === true,
    verify: values.verify !== false,
  }
}

main().catch((err) => {
  log.error('pg-migrate failed', { err: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
