#!/usr/bin/env tsx
/**
 * Incremental re-embed script.
 *
 * Contract from BLUEPRINT--memory §layers.vector.rebuild:
 *   - trigger_script: scripts/msp/re-embed.mjs
 *   - incremental: only re-embed changed files
 *   - manifest_file: _manifest.json with embedder_model, dimension,
 *     doc_count, last_updated, file_hashes
 *
 * Behavior:
 *   - For each source file matching the glob, compare SHA-256 to
 *     manifest.file_hashes[relPath]. Skip if unchanged.
 *   - If the manifest's embedder model or dimension differs from the
 *     current embedder, FORCE a full rebuild (no half-dim stores).
 *   - Chunks each changed file with chunkMarkdown() and writes
 *     (doc_id = sha256(relPath + chunkIndex)) so repeat runs are stable.
 *   - Removes chunks of deleted files (identified by relPath no longer
 *     in the source glob).
 *   - Updates the manifest atomically at the end.
 *
 * Usage:
 *   tsx scripts/msp/re-embed.ts --store=atomic --source='gks/**\/*.md'
 *   tsx scripts/msp/re-embed.ts --store=atomic --full      # force re-embed
 *   tsx scripts/msp/re-embed.ts --dry-run                   # plan only
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { MemoryStore } from '../../src/memory/index.js'
import { chunkMarkdown } from '../../src/memory/vector/chunker.js'
import { createEmbedder } from '../../src/memory/vector/embedder.js'
import { manifestCompatible, readManifest } from '../../src/memory/vector/manifest.js'
import type { VectorDoc, VectorMetadata } from '../../src/memory/types.js'
import { createLogger } from '../../src/lib/logger.js'

const log = createLogger('script:re-embed')

interface Options {
  root: string
  store: 'atomic' | 'obsidian' | 'episodic' | string
  sourceDir: string
  pattern: RegExp
  full: boolean
  dryRun: boolean
  maxTokens: number
  overlap: number
  provider: 'auto' | 'ollama' | 'openai' | 'mock'
  excludes: RegExp[]
}

async function main(): Promise<void> {
  const opts = parseOptions()
  log.info('re-embed starting', {
    store: opts.store,
    sourceDir: opts.sourceDir,
    full: opts.full,
    dryRun: opts.dryRun,
  })

  const files = await walkMarkdown(opts.sourceDir, opts.pattern, opts.excludes)
  log.info('source files discovered', { count: files.length })

  const embedder = await createEmbedder({
    ...(opts.provider !== 'auto' ? { forceProvider: opts.provider } : {}),
  })
  const memStore = new MemoryStore({
    root: opts.root,
    embedder,
    reranker: { enabled: false }, // not needed during ingestion
  })
  await memStore.init()
  const vStore = await memStore.getVectorStore(opts.store)

  // Decide whether a full rebuild is forced by manifest incompatibility.
  const onDiskManifest = await readManifest(resolve(opts.root, '.brain/msp/projects/evaAI/vector'))
  const modelCompat =
    onDiskManifest == null ||
    manifestCompatible(onDiskManifest, embedder.model, embedder.dimension)
  if (!modelCompat) {
    log.warn('embedder model/dim changed — forcing full rebuild', {
      old_model: onDiskManifest?.embedder_model,
      old_dim: onDiskManifest?.dimension,
      new_model: embedder.model,
      new_dim: embedder.dimension,
    })
    opts.full = true
  }

  // Build the set of existing relPaths in the manifest to detect deletions.
  const knownPaths = new Set(Object.keys(onDiskManifest?.file_hashes ?? {}))

  // Hash every source file so we know what changed.
  const currentHashes = await hashFiles(opts.sourceDir, files)
  const changed: string[] = []
  const unchanged: string[] = []
  const deleted: string[] = []

  for (const [relPath, hash] of currentHashes) {
    if (opts.full) {
      changed.push(relPath)
      continue
    }
    const prev = onDiskManifest?.file_hashes?.[relPath]
    if (prev !== hash) changed.push(relPath)
    else unchanged.push(relPath)
  }
  for (const prev of knownPaths) {
    if (!currentHashes.has(prev)) deleted.push(prev)
  }

  log.info('plan ready', {
    changed: changed.length,
    unchanged: unchanged.length,
    deleted: deleted.length,
    mode: opts.full ? 'full' : 'incremental',
  })

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: opts.full ? 'full' : 'incremental',
          changed,
          unchanged_count: unchanged.length,
          deleted,
        },
        null,
        2,
      ),
    )
    return
  }

  // For a full rebuild, clear the store before reseeding — avoids leftover docs.
  if (opts.full && vStore.size() > 0) {
    await vStore.clear()
  }

  // Full rebuild: re-embed everything. Incremental: merge changed+deleted into
  // the existing doc list.
  let existingDocs: VectorDoc[] = opts.full ? [] : [...vStore.listDocs()]

  // Drop docs belonging to changed-or-deleted relPaths.
  if (!opts.full) {
    const drop = new Set([...changed, ...deleted])
    existingDocs = existingDocs.filter((d) => !drop.has(d.metadata['path'] as string))
  }

  // Embed the changed files.
  const changedFiles = opts.full ? [...currentHashes.keys()] : changed
  const newDocs: Array<{ text: string; metadata: VectorMetadata; id: string; source: string }> = []
  for (const relPath of changedFiles) {
    const abs = resolve(opts.sourceDir, relPath)
    const source = await readFile(abs, 'utf8')
    const { chunks } = chunkMarkdown(source, {
      maxTokens: opts.maxTokens,
      overlap: opts.overlap,
    })
    chunks.forEach((chunk, idx) => {
      newDocs.push({
        id: docId(relPath, idx, currentHashes.get(relPath)!),
        source: relPath,
        text: chunk.text,
        metadata: {
          path: relPath,
          heading: chunk.heading,
          tokens: chunk.tokenCount,
          hash: currentHashes.get(relPath)!,
          tags: chunk.headingPath.length > 0 ? chunk.headingPath : undefined,
        } as VectorMetadata,
      })
    })
  }

  if (newDocs.length > 0) {
    log.info('embedding batch', {
      chunks: newDocs.length,
      provider: embedder.provider,
      model: embedder.model,
    })
    await vStore.addBatch(newDocs)
  }

  // Update file_hashes in the manifest; delete entries for removed paths.
  // setFileHash is optional on VectorBackend — skip gracefully if a custom
  // backend doesn't implement it (manifest will lag but incremental mode
  // still works against the on-disk JSONL default).
  if (vStore.setFileHash) {
    const setFileHash = vStore.setFileHash.bind(vStore)
    for (const relPath of deleted) {
      await setFileHash(relPath, '') // empty = tombstone
    }
    for (const [relPath, hash] of currentHashes) {
      await setFileHash(relPath, hash)
    }
  }

  const finalManifest = vStore.getManifest()
  log.info('re-embed complete', {
    store: opts.store,
    docs: finalManifest.doc_count,
    embedder: finalManifest.embedder_model,
    dim: finalManifest.dimension,
  })

  console.log(
    JSON.stringify(
      {
        mode: opts.full ? 'full' : 'incremental',
        store: opts.store,
        changed: changed.length,
        unchanged: unchanged.length,
        deleted: deleted.length,
        new_chunks: newDocs.length,
        total_docs: finalManifest.doc_count,
        embedder: { model: finalManifest.embedder_model, dim: finalManifest.dimension },
      },
      null,
      2,
    ),
  )
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function walkMarkdown(
  root: string,
  pattern: RegExp,
  excludes: RegExp[],
): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string) {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      const rel = relative(root, full)
      if (excludes.some((rx) => rx.test(rel))) continue
      if (ent.isDirectory()) {
        await visit(full)
      } else if (ent.isFile() && pattern.test(ent.name)) {
        out.push(rel)
      }
    }
  }
  await visit(root)
  return out.sort()
}

async function hashFiles(root: string, relPaths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const rel of relPaths) {
    const abs = resolve(root, rel)
    const buf = await readFile(abs)
    const hash = createHash('sha256').update(buf).digest('hex')
    out.set(rel, hash)
  }
  return out
}

function docId(relPath: string, chunkIdx: number, fileHash: string): string {
  // Deterministic IDs so incremental runs don't churn unrelated docs.
  const h = createHash('sha256').update(`${relPath}::${chunkIdx}::${fileHash}`).digest('hex')
  return h.slice(0, 32)
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string' },
      store: { type: 'string' },
      source: { type: 'string' },
      pattern: { type: 'string' },
      full: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'max-tokens': { type: 'string' },
      overlap: { type: 'string' },
      provider: { type: 'string' },
      exclude: { type: 'string', multiple: true },
    },
  })

  const root = resolve((values.root as string | undefined) ?? '.')
  const store = ((values.store as string | undefined) ?? 'atomic') as Options['store']
  const sourceDir = resolve(
    (values.source as string | undefined) ?? join(root, 'gks'),
  )
  const patternStr = (values.pattern as string | undefined) ?? '\\.md$'
  const pattern = new RegExp(patternStr, 'i')
  const excludes = [
    /\.excalidraw\.md$/i,
    /(^|[\\/])archive[\\/]/i,
    /(^|[\\/])\..+[\\/]/i, // skip hidden dirs
    ...(Array.isArray(values.exclude) ? values.exclude.map((p) => new RegExp(p, 'i')) : []),
  ]

  return {
    root,
    store,
    sourceDir,
    pattern,
    full: values.full === true,
    dryRun: values['dry-run'] === true,
    maxTokens: Number(values['max-tokens'] ?? 512),
    overlap: Number(values.overlap ?? 64),
    provider: (values.provider as Options['provider']) ?? 'auto',
    excludes,
  }
}

main().catch((err) => {
  log.error('re-embed failed', {
    err: (err as Error).message,
    stack: (err as Error).stack,
  })
  process.exit(1)
})
