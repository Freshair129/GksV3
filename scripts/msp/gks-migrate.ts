#!/usr/bin/env tsx
/**
 * gks-migrate — apply on-disk schema migrations.
 *
 * Reads the manifest at <store>/_manifest.json (default
 * .brain/msp/projects/evaAI/vector/), inspects schema_version, and
 * runs the matching migration(s) up to the runtime CURRENT_SCHEMA_VERSION.
 *
 * Usage
 *   npm run gks-migrate                                  # dry-run, prints plan
 *   npm run gks-migrate -- --apply                       # apply migrations
 *   npm run gks-migrate -- --vector-dir=/abs/path
 *
 * Migrations live in `MIGRATIONS` below — append to the array as the
 * schema evolves. Each entry knows how to upgrade FROM its own version
 * TO the next; the runner walks them in order.
 */

import { mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { readJsonSafe, writeJson } from '../../src/lib/jsonl.js'
import {
  CURRENT_SCHEMA_VERSION,
  checkSchemaCompatibility,
} from '../../src/lib/schema-version.js'
import { createLogger } from '../../src/lib/logger.js'
import type { VectorManifest } from '../../src/memory/types.js'

const log = createLogger('script:gks-migrate')

interface Migration {
  /** Version this migration moves the store FROM. */
  from: string
  /** Version this migration moves the store TO. */
  to: string
  /** Apply the migration in-place; should be idempotent. */
  apply(args: { vectorDir: string }): Promise<void>
}

const MIGRATIONS: Migration[] = [
  // Append migrations here as the schema evolves. Today the on-disk schema
  // is at 1.0.0 — no migrations are needed yet. The first one will look
  // something like:
  //
  //   {
  //     from: '1.0.0',
  //     to: '1.1.0',
  //     async apply({ vectorDir }) {
  //       // walk *.jsonl files in vectorDir and rewrite each row
  //     },
  //   },
]

interface Options {
  vectorDir: string
  apply: boolean
}

async function main(): Promise<void> {
  const opts = parseOptions()
  await mkdir(opts.vectorDir, { recursive: true })

  // Inspect every store sitting under the vectorDir. Each has its own
  // _manifest.json (today there's only one shared manifest, but the loop
  // is forward-compatible with per-store manifests).
  const manifestPath = join(opts.vectorDir, '_manifest.json')
  const manifest = await readJsonSafe<VectorManifest>(manifestPath)
  if (!manifest) {
    log.info('no manifest found — nothing to migrate', { vectorDir: opts.vectorDir })
    console.log(JSON.stringify({ ok: true, applied: [] }, null, 2))
    return
  }

  const onDisk = manifest.schema_version ?? '1.0.0'
  const cmp = checkSchemaCompatibility(onDisk)
  log.info('manifest inspected', {
    onDisk,
    runtime: CURRENT_SCHEMA_VERSION,
    compatibility: cmp.kind,
  })

  if (cmp.kind === 'same') {
    console.log(JSON.stringify({ ok: true, on_disk: onDisk, applied: [] }, null, 2))
    return
  }
  if (cmp.kind === 'newer_than_runtime') {
    log.error('on-disk schema is newer than runtime', { onDisk, runtime: CURRENT_SCHEMA_VERSION })
    process.exit(2)
  }

  // Build the migration chain.
  const plan = buildPlan(onDisk, CURRENT_SCHEMA_VERSION)
  if (plan === null) {
    log.error('no migration path available', { from: onDisk, to: CURRENT_SCHEMA_VERSION })
    process.exit(3)
  }

  if (!opts.apply) {
    log.info('dry-run — pass --apply to execute', {
      steps: plan.length,
      chain: plan.map((m) => `${m.from}→${m.to}`),
    })
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          on_disk: onDisk,
          target: CURRENT_SCHEMA_VERSION,
          plan: plan.map((m) => ({ from: m.from, to: m.to })),
        },
        null,
        2,
      ),
    )
    return
  }

  // Apply each step. Bump the manifest after each so a partial-failure
  // can be resumed from the last successful step.
  const applied: Array<{ from: string; to: string }> = []
  for (const step of plan) {
    log.info('applying migration', { from: step.from, to: step.to })
    await step.apply({ vectorDir: opts.vectorDir })
    const fresh = await readJsonSafe<VectorManifest>(manifestPath)
    if (fresh) {
      await writeJson(manifestPath, { ...fresh, schema_version: step.to })
    }
    applied.push({ from: step.from, to: step.to })
  }

  console.log(
    JSON.stringify(
      { ok: true, on_disk_was: onDisk, on_disk_now: CURRENT_SCHEMA_VERSION, applied },
      null,
      2,
    ),
  )
}

function buildPlan(from: string, to: string): Migration[] | null {
  const plan: Migration[] = []
  let current = from
  // Walk forward until we hit `to` or run out.
  // (Iteration cap keeps a buggy migrations list from looping forever.)
  for (let i = 0; i < 100 && current !== to; i++) {
    const next = MIGRATIONS.find((m) => m.from === current)
    if (!next) return null
    plan.push(next)
    current = next.to
  }
  return current === to ? plan : null
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'vector-dir': { type: 'string' },
      apply: { type: 'boolean' },
    },
  })
  const vectorDir = resolve(
    (values['vector-dir'] as string | undefined) ??
      process.env['GKS_VECTOR_DIR'] ??
      '.brain/msp/projects/evaAI/vector',
  )
  const apply = values.apply === true
  return { vectorDir, apply }
}

void readdir

main().catch((err) => {
  log.error('gks-migrate failed', { err: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
