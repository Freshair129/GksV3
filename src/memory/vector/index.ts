/**
 * Layer 2 — Vector Store (file-based JSONL).
 *
 * Contract from BLUEPRINT--memory §layers.vector:
 *   - stores: atomic / obsidian / episodic (each its own .jsonl file)
 *   - search: cosine_brute_force, topK default 5, threshold 0.35
 *   - incremental rebuild via manifest + file_hashes
 *   - namespace scoping via metadata.{user_id, session_id, agent_id}
 *
 * Store layout on disk:
 *   <storeDir>/<name>.jsonl        # one VectorDoc per line
 *   <storeDir>/_manifest.json      # embedder info + file hashes
 */

import { dirname, resolve } from 'node:path'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import type {
  VectorDoc,
  VectorHit,
  VectorManifest,
  VectorMetadata,
  VectorSearchOptions,
} from '../types.js'
import { appendJsonl, forEachJsonl, writeJsonl } from '../../lib/jsonl.js'
import { cosine, topK } from './similarity.js'
import {
  emptyManifest,
  manifestCompatible,
  readManifest,
  writeManifest,
} from './manifest.js'
import type { Embedder } from './embedder.js'
import { createLogger } from '../../lib/logger.js'
import {
  CURRENT_SCHEMA_VERSION,
  enforceSchemaCompatibility,
} from '../../lib/schema-version.js'

const log = createLogger('vector:store')

export interface VectorStoreOptions {
  /** Absolute path to the JSONL store file. */
  path: string
  /** Embedder whose (model, dimension) pins this store. */
  embedder: Embedder
  /** Store name used in logs + manifest dir resolution. */
  name?: string
  /** Auto-load existing file on construction. Default true. */
  autoLoad?: boolean
  /** Default score threshold (overridable per search()). */
  scoreThreshold?: number
}

import type { VectorBackend } from './backend.js'

/**
 * In-memory + on-disk JSONL vector store. All docs held in memory for Phase 1;
 * swap in a streaming/mmap variant once we cross ~100k docs.
 *
 * Implements the VectorBackend interface so callers that depend on the
 * abstraction can swap in pgvector/HNSW/Turbopuffer without changes.
 */
export class VectorStore implements VectorBackend {
  readonly path: string
  readonly name: string
  readonly embedder: Embedder
  private readonly storeDir: string
  private readonly scoreThreshold: number

  private docs: VectorDoc[] = []
  private byId = new Map<string, VectorDoc>()
  private manifest: VectorManifest
  private loaded = false
  private autoLoad: boolean

  constructor(opts: VectorStoreOptions) {
    this.path = resolve(opts.path)
    this.storeDir = dirname(this.path)
    this.name = opts.name ?? basename(this.path)
    this.embedder = opts.embedder
    this.scoreThreshold = opts.scoreThreshold ?? 0.35
    this.autoLoad = opts.autoLoad ?? true
    this.manifest = emptyManifest(opts.embedder.model, opts.embedder.dimension)
  }

  /**
   * Load docs from disk. Verifies that the on-disk manifest matches the
   * current embedder (model + dimension). If not, marks the store as
   * incompatible — caller must rebuild before adding new vectors.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.storeDir, { recursive: true })

    const onDisk = await readManifest(this.storeDir)
    if (onDisk) {
      // Schema version check — throws on incompatible major (or
      // newer-than-runtime) so we never silently corrupt data; logs on
      // minor / patch upgrades.
      const cmp = enforceSchemaCompatibility(onDisk.schema_version)
      if (cmp.kind === 'minor_upgrade' || cmp.kind === 'patch_upgrade') {
        log.info('vector store schema upgrade applied on load', {
          store: this.name,
          from: cmp.from,
          to: cmp.to,
        })
      }
      this.manifest = { ...onDisk, schema_version: CURRENT_SCHEMA_VERSION }
      if (!manifestCompatible(onDisk, this.embedder.model, this.embedder.dimension)) {
        log.warn('vector store manifest incompatible with current embedder', {
          store: this.name,
          on_disk: { model: onDisk.embedder_model, dim: onDisk.dimension },
          current: { model: this.embedder.model, dim: this.embedder.dimension },
        })
      }
    }

    try {
      await forEachJsonl<VectorDoc>(this.path, (row) => {
        this.docs.push(row)
        this.byId.set(row.id, row)
      })
      log.info('vector store loaded', {
        store: this.name,
        docs: this.docs.length,
        path: this.path,
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
      log.info('vector store new (no file yet)', { store: this.name, path: this.path })
    }

    this.loaded = true
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded && this.autoLoad) await this.load()
  }

  size(): number {
    return this.docs.length
  }

  getManifest(): VectorManifest {
    return { ...this.manifest }
  }

  /**
   * Add a single text+metadata pair — embeds, assigns an ID, appends to JSONL.
   * Returns the created doc.
   */
  async add(
    text: string,
    metadata: VectorMetadata,
    opts: { id?: string; chunkId?: string; source?: string } = {},
  ): Promise<VectorDoc> {
    const vector = await this.embedder.embed(text)
    return this.addWithVector(text, vector, metadata, opts)
  }

  async addWithVector(
    text: string,
    vector: number[],
    metadata: VectorMetadata,
    opts: { id?: string; chunkId?: string; source?: string } = {},
  ): Promise<VectorDoc> {
    await this.ensureLoaded()
    this.assertCompatible()

    if (vector.length !== this.embedder.dimension) {
      throw new Error(
        `vector dim ${vector.length} but embedder declared ${this.embedder.dimension}`,
      )
    }

    const id = opts.id ?? randomUUID()
    const doc: VectorDoc = {
      id,
      source: opts.source ?? metadata.path ?? 'inline',
      chunk_id: opts.chunkId ?? id,
      text,
      vector,
      metadata: { created_at: new Date().toISOString(), ...metadata },
    }

    this.docs.push(doc)
    this.byId.set(id, doc)
    await appendJsonl(this.path, doc)
    await this.bumpManifest()
    return doc
  }

  /**
   * Batch add — embeds in one call, appends atomically.
   */
  async addBatch(
    items: Array<{
      text: string
      metadata: VectorMetadata
      id?: string
      chunkId?: string
      source?: string
    }>,
  ): Promise<VectorDoc[]> {
    if (items.length === 0) return []
    await this.ensureLoaded()
    this.assertCompatible()

    const vectors = await this.embedder.embedBatch(items.map((i) => i.text))
    const now = new Date().toISOString()
    const docs: VectorDoc[] = items.map((item, i) => {
      const vec = vectors[i]!
      if (vec.length !== this.embedder.dimension) {
        throw new Error(
          `embedder returned dim ${vec.length} but declared ${this.embedder.dimension}`,
        )
      }
      const id = item.id ?? randomUUID()
      return {
        id,
        source: item.source ?? item.metadata.path ?? 'inline',
        chunk_id: item.chunkId ?? id,
        text: item.text,
        vector: vec,
        metadata: { created_at: now, ...item.metadata },
      }
    })

    for (const d of docs) {
      this.docs.push(d)
      this.byId.set(d.id, d)
      await appendJsonl(this.path, d)
    }
    await this.bumpManifest()
    return docs
  }

  /**
   * Semantic search via cosine brute force. Accepts either a raw text query
   * (embedded here) or a pre-computed query vector.
   */
  async search(
    query: string | number[],
    opts: VectorSearchOptions = {},
  ): Promise<VectorHit[]> {
    await this.ensureLoaded()
    if (this.docs.length === 0) return []

    const qvec = typeof query === 'string' ? await this.embedder.embed(query) : query
    if (qvec.length !== this.embedder.dimension) {
      // Don't crash — searches against an incompatible store return 0 hits so
      // the unified Recall() can still serve the other layers.
      log.warn('search query dim mismatch, returning empty', {
        store: this.name,
        query_dim: qvec.length,
        store_dim: this.embedder.dimension,
      })
      return []
    }

    return topK(qvec, this.docs, {
      topK: opts.topK ?? 5,
      scoreThreshold: opts.scoreThreshold ?? this.scoreThreshold,
      ...(opts.filter ? { filter: opts.filter } : {}),
    })
  }

  /** Cosine score between an arbitrary query vector and a stored doc. Used for reranking. */
  scoreAgainst(queryVec: number[], docId: string): number | null {
    const doc = this.byId.get(docId)
    if (!doc) return null
    return cosine(queryVec, doc.vector)
  }

  async get(id: string): Promise<VectorDoc | undefined> {
    return this.byId.get(id)
  }

  /** Synchronous lookup — only valid on memory-resident backends. */
  getSync(id: string): VectorDoc | undefined {
    return this.byId.get(id)
  }

  listDocs(): readonly VectorDoc[] {
    return this.docs
  }

  /**
   * Patch a stored doc's metadata. Rewrites the JSONL file atomically. Used by
   * the bi-temporal conflict resolver to flip `valid_to` / `superseded_by`
   * without re-embedding.
   *
   * Returns the new doc, or null if `id` is unknown.
   */
  async patchMetadata(
    id: string,
    patch: Partial<VectorMetadata>,
  ): Promise<VectorDoc | null> {
    const [result] = await this.patchMetadataMany([{ id, patch }])
    return result ?? null
  }

  /**
   * Batch variant: apply each patch in-memory, then rewrite the JSONL ONCE.
   * Avoids the O(N·docCount) rewrite-per-patch hit on the bi-temporal
   * supersede path (which may invalidate multiple predecessors per retain).
   */
  async patchMetadataMany(
    patches: ReadonlyArray<{ id: string; patch: Partial<VectorMetadata> }>,
  ): Promise<Array<VectorDoc | null>> {
    await this.ensureLoaded()
    const results: Array<VectorDoc | null> = []
    let anyChanged = false

    for (const { id, patch } of patches) {
      const existing = this.byId.get(id)
      if (!existing) {
        results.push(null)
        continue
      }
      const updated: VectorDoc = {
        ...existing,
        metadata: { ...existing.metadata, ...patch },
      }
      const idx = this.docs.findIndex((d) => d.id === id)
      if (idx >= 0) this.docs[idx] = updated
      this.byId.set(id, updated)
      results.push(updated)
      anyChanged = true
    }

    if (anyChanged) await this.rewriteAll(this.docs)
    return results
  }

  /** Rewrite the entire store file atomically (used by the rebuild script). */
  async rewriteAll(docs: VectorDoc[]): Promise<void> {
    await mkdir(this.storeDir, { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeJsonl(tmp, docs)
    await rename(tmp, this.path)
    this.docs = [...docs]
    this.byId = new Map(docs.map((d) => [d.id, d]))
    this.manifest = {
      embedder_model: this.embedder.model,
      dimension: this.embedder.dimension,
      doc_count: docs.length,
      last_updated: new Date().toISOString(),
      file_hashes: this.manifest.file_hashes,
    }
    await writeManifest(this.storeDir, this.manifest)
  }

  /** Update a file hash entry in the manifest (used by incremental rebuilds). */
  async setFileHash(relPath: string, hash: string): Promise<void> {
    this.manifest = {
      ...this.manifest,
      file_hashes: { ...this.manifest.file_hashes, [relPath]: hash },
      last_updated: new Date().toISOString(),
    }
    await writeManifest(this.storeDir, this.manifest)
  }

  /** Clear the store (file + in-memory). Used by tests and full rebuilds. */
  async clear(): Promise<void> {
    this.docs = []
    this.byId.clear()
    await mkdir(this.storeDir, { recursive: true })
    await writeFile(this.path, '', 'utf8')
    this.manifest = emptyManifest(this.embedder.model, this.embedder.dimension)
    await writeManifest(this.storeDir, this.manifest)
  }

  private async bumpManifest(): Promise<void> {
    this.manifest = {
      ...this.manifest,
      embedder_model: this.embedder.model,
      dimension: this.embedder.dimension,
      doc_count: this.docs.length,
      last_updated: new Date().toISOString(),
      schema_version: CURRENT_SCHEMA_VERSION,
    }
    await writeManifest(this.storeDir, this.manifest)
  }

  private assertCompatible(): void {
    if (!manifestCompatible(this.manifest, this.embedder.model, this.embedder.dimension)) {
      // Soft-assert: if the store was empty we can just adopt the embedder.
      if (this.docs.length === 0) {
        this.manifest = emptyManifest(this.embedder.model, this.embedder.dimension)
        return
      }
      throw new Error(
        `vector store '${this.name}' was built with ${this.manifest.embedder_model}` +
          ` (dim ${this.manifest.dimension}) but current embedder is ${this.embedder.model}` +
          ` (dim ${this.embedder.dimension}). Rebuild required.`,
      )
    }
  }
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  const tail = idx === -1 ? p : p.slice(idx + 1)
  return tail.endsWith('.jsonl') ? tail.slice(0, -6) : tail
}
