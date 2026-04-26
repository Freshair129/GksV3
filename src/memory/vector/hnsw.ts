/**
 * HNSW in-process VectorBackend.
 *
 * Stores vectors in a binary HNSW index file (via hnswlib-node) plus a
 * separate metadata JSONL — keeps recall O(log N) at meaningful scale
 * without standing up Postgres.
 *
 * Persistence layout
 *   <basePath>.hnsw       binary HNSW index (vectors + graph)
 *   <basePath>.meta.jsonl one line per doc: { id, source, chunk_id, text,
 *                          metadata, label }   ← no vector field; vectors
 *                          live only in the HNSW file.
 *   <basePath>.json       small manifest mirror of VectorManifest.
 *
 * Trade-offs vs JsonlVectorStore
 *   + Search is O(log N) instead of O(N·d)
 *   + Lower memory than the in-memory cosine_brute_force at >100k docs
 *   – Native dep (hnswlib-node, prebuilt or from-source)
 *   – `clear()` requires a full re-init; metadata-only patches are still
 *     metadata-only (the index isn't touched).
 *   – Embedder change forces a full rebuild — same as pgvector.
 *
 * HNSW labels are integers; this backend maps them to the public string IDs.
 * Label allocation is monotonic (`nextLabel`), so deletes leave gaps that
 * are reclaimed only on rebuild — same model as pgvector + WAL.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import type {
  VectorBackend,
  VectorBackendAddItem,
} from './backend.js'
import type {
  VectorDoc,
  VectorHit,
  VectorManifest,
  VectorMetadata,
  VectorSearchOptions,
} from '../types.js'
import type { Embedder } from './embedder.js'
import {
  appendJsonl,
  fileExists,
  forEachJsonl,
  readJsonSafe,
  writeJson,
  writeJsonl,
} from '../../lib/jsonl.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('vector:hnsw')

// hnswlib-node binding shape mirrored from the package's own .d.ts. Read /
// write are async (Promise-returning); their *Sync siblings exist but we
// stick with async to keep the load() path off the event loop.
interface HierarchicalNSW {
  initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number): void
  readIndex(filename: string, allowReplaceDeleted?: boolean): Promise<boolean>
  writeIndex(filename: string): Promise<boolean>
  resizeIndex(newMaxElements: number): void
  addPoint(point: number[], label: number, replaceDeleted?: boolean): void
  markDelete(label: number): void
  searchKnn(point: number[], k: number, filter?: (label: number) => boolean): {
    distances: number[]
    neighbors: number[]
  }
  setEf(ef: number): void
  getCurrentCount(): number
  getMaxElements(): number
}

interface HnswlibModule {
  HierarchicalNSW: new (
    space: 'cosine' | 'l2' | 'ip',
    dim: number,
  ) => HierarchicalNSW
}

export interface HnswBackendOptions {
  /** Absolute base path; the backend writes <base>.hnsw / .meta.jsonl / .json */
  basePath: string
  embedder: Embedder
  /** Logical store name — kept for parity with the JSONL/pgvector backends. */
  name: string
  /** HNSW build params. m=16 + efConstruction=64 follows the BGE-rerank docs. */
  m?: number
  efConstruction?: number
  /** Query-time ef. Higher = better recall, slower. Default 40. */
  efSearch?: number
  /** Initial capacity; index grows in 2× steps when full. Default 10000. */
  initialMaxElements?: number
  /** Default score threshold (passed through). */
  scoreThreshold?: number
}

export async function createHnswBackend(opts: HnswBackendOptions): Promise<VectorBackend> {
  const backend = new HnswBackend(opts)
  await backend.load()
  return backend
}

class HnswBackend implements VectorBackend {
  readonly name: string
  readonly embedder: Embedder

  private readonly basePath: string
  private readonly indexPath: string
  private readonly metaPath: string
  private readonly manifestPath: string
  private readonly m: number
  private readonly efConstruction: number
  private readonly efSearch: number
  private readonly scoreThreshold: number
  private maxElements: number

  private hnsw: HierarchicalNSW | null = null
  private byId = new Map<string, VectorDoc>()
  private idToLabel = new Map<string, number>()
  private labelToId: string[] = []
  private nextLabel = 0
  private manifest: VectorManifest

  private loaded = false

  constructor(opts: HnswBackendOptions) {
    this.basePath = resolve(opts.basePath)
    this.indexPath = `${this.basePath}.hnsw`
    this.metaPath = `${this.basePath}.meta.jsonl`
    this.manifestPath = `${this.basePath}.json`
    this.embedder = opts.embedder
    this.name = opts.name
    this.m = opts.m ?? 16
    this.efConstruction = opts.efConstruction ?? 64
    this.efSearch = opts.efSearch ?? 40
    this.scoreThreshold = opts.scoreThreshold ?? 0.35
    this.maxElements = opts.initialMaxElements ?? 10_000
    this.manifest = this.emptyManifest()
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await mkdir(dirname(this.basePath), { recursive: true })

    const hnswlib = await loadHnswlib()
    this.hnsw = new hnswlib.HierarchicalNSW('cosine', this.embedder.dimension)

    const onDiskManifest = await readJsonSafe<VectorManifest & { max_elements?: number }>(
      this.manifestPath,
    )

    const indexExists = await fileExists(this.indexPath)
    if (indexExists && onDiskManifest) {
      // Reload into the existing index.
      const incompatible =
        onDiskManifest.embedder_model !== this.embedder.model ||
        onDiskManifest.dimension !== this.embedder.dimension
      if (incompatible) {
        log.warn('hnsw index incompatible with current embedder — initializing empty', {
          on_disk: { model: onDiskManifest.embedder_model, dim: onDiskManifest.dimension },
          current: { model: this.embedder.model, dim: this.embedder.dimension },
        })
        this.initEmpty()
        // Stale .hnsw + .meta.jsonl now that the embedder changed; truncate
        // both so a subsequent loadMetadata() doesn't repopulate byId with
        // entries whose vectors aren't in the new index.
        await rm(this.indexPath, { force: true })
        await writeFile(this.metaPath, '', 'utf8')
      } else {
        this.maxElements =
          onDiskManifest.max_elements ?? Math.max(this.maxElements, onDiskManifest.doc_count + 1)
        await this.hnsw.readIndex(this.indexPath, false)
        this.hnsw.setEf(this.efSearch)
        this.manifest = onDiskManifest
      }
    } else {
      this.initEmpty()
    }

    // Replay metadata JSONL so byId / labelToId are consistent with the index.
    await this.loadMetadata()

    this.loaded = true
    log.info('hnsw backend loaded', {
      store: this.name,
      docs: this.byId.size,
      max_elements: this.maxElements,
    })
  }

  size(): number {
    return this.byId.size
  }

  getManifest(): VectorManifest {
    return this.manifest
  }

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
    this.assertDim(vector.length)

    const id = opts.id ?? randomUUID()
    const doc: VectorDoc = {
      id,
      source: opts.source ?? metadata.path ?? 'inline',
      chunk_id: opts.chunkId ?? id,
      text,
      vector,
      metadata: { created_at: new Date().toISOString(), ...metadata },
    }

    const label = this.allocateLabel(id)
    this.ensureCapacity(this.byId.size + 1)
    this.hnsw!.addPoint(vector, label)

    this.byId.set(id, doc)
    await this.appendMeta(doc, label)
    await this.persistIndex()
    await this.bumpManifest(+1)
    return doc
  }

  async addBatch(items: VectorBackendAddItem[]): Promise<VectorDoc[]> {
    if (items.length === 0) return []
    await this.ensureLoaded()

    const vectors = await this.embedder.embedBatch(items.map((i) => i.text))
    const now = new Date().toISOString()
    const docs: VectorDoc[] = items.map((item, i) => {
      const vec = vectors[i]!
      this.assertDim(vec.length)
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

    this.ensureCapacity(this.byId.size + docs.length)

    for (const doc of docs) {
      const label = this.allocateLabel(doc.id)
      this.hnsw!.addPoint(doc.vector, label)
      this.byId.set(doc.id, doc)
      await this.appendMeta(doc, label)
    }

    await this.persistIndex()
    await this.bumpManifest(docs.length)
    return docs
  }

  async search(
    query: string | number[],
    opts: VectorSearchOptions = {},
  ): Promise<VectorHit[]> {
    await this.ensureLoaded()
    if (this.byId.size === 0) return []

    const qvec = typeof query === 'string' ? await this.embedder.embed(query) : query
    if (qvec.length !== this.embedder.dimension) {
      log.warn('hnsw search query dim mismatch — empty', {
        store: this.name,
        query_dim: qvec.length,
        store_dim: this.embedder.dimension,
      })
      return []
    }

    const k = Math.min(opts.topK ?? 5, this.byId.size)
    const threshold = opts.scoreThreshold ?? this.scoreThreshold
    const filterFn = opts.filter
      ? (label: number) => {
          const id = this.labelToId[label]
          if (id === undefined) return false
          const doc = this.byId.get(id)
          if (!doc) return false
          return matchesFilter(doc.metadata, opts.filter!)
        }
      : undefined

    // hnswlib returns COSINE DISTANCE in [0, 2]. Convert to similarity.
    const result = this.hnsw!.searchKnn(qvec, k, filterFn)
    const hits: VectorHit[] = []
    for (let i = 0; i < result.neighbors.length; i++) {
      const id = this.labelToId[result.neighbors[i]!]
      if (id === undefined) continue
      const doc = this.byId.get(id)
      if (!doc) continue
      const score = 1 - result.distances[i]!
      if (score < threshold) continue
      hits.push({ doc, score })
    }
    return hits
  }

  async patchMetadata(
    id: string,
    patch: Partial<VectorMetadata>,
  ): Promise<VectorDoc | null> {
    const [result] = await this.patchMetadataMany([{ id, patch }])
    return result ?? null
  }

  async patchMetadataMany(
    patches: ReadonlyArray<{ id: string; patch: Partial<VectorMetadata> }>,
  ): Promise<Array<VectorDoc | null>> {
    if (patches.length === 0) return []
    await this.ensureLoaded()

    const out: Array<VectorDoc | null> = []
    let anyChanged = false
    for (const { id, patch } of patches) {
      const existing = this.byId.get(id)
      if (!existing) {
        out.push(null)
        continue
      }
      const updated: VectorDoc = {
        ...existing,
        metadata: { ...existing.metadata, ...patch },
      }
      this.byId.set(id, updated)
      out.push(updated)
      anyChanged = true
    }
    // Patches don't touch the HNSW vectors — just rewrite the metadata JSONL.
    if (anyChanged) await this.rewriteMetadata()
    return out
  }

  async get(id: string): Promise<VectorDoc | undefined> {
    await this.ensureLoaded()
    return this.byId.get(id)
  }

  listDocs(): readonly VectorDoc[] {
    return [...this.byId.values()]
  }

  async clear(): Promise<void> {
    await this.ensureLoaded()
    this.byId.clear()
    this.idToLabel.clear()
    this.labelToId = []
    this.nextLabel = 0

    const hnswlib = await loadHnswlib()
    this.hnsw = new hnswlib.HierarchicalNSW('cosine', this.embedder.dimension)
    this.initEmpty()

    await rm(this.indexPath, { force: true })
    await writeFile(this.metaPath, '', 'utf8')
    this.manifest = this.emptyManifest()
    await writeJson(this.manifestPath, { ...this.manifest, max_elements: this.maxElements })
  }

  async setFileHash(relPath: string, hash: string): Promise<void> {
    this.manifest = {
      ...this.manifest,
      file_hashes: { ...this.manifest.file_hashes, [relPath]: hash },
      last_updated: new Date().toISOString(),
    }
    await writeJson(this.manifestPath, { ...this.manifest, max_elements: this.maxElements })
  }

  // ─── internal ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  private assertDim(actual: number): void {
    if (actual !== this.embedder.dimension) {
      throw new Error(
        `vector dim ${actual} but embedder declared ${this.embedder.dimension}`,
      )
    }
  }

  private emptyManifest(): VectorManifest {
    return {
      embedder_model: this.embedder.model,
      dimension: this.embedder.dimension,
      doc_count: 0,
      last_updated: new Date().toISOString(),
      file_hashes: {},
    }
  }

  private initEmpty(): void {
    this.hnsw!.initIndex(this.maxElements, this.m, this.efConstruction)
    this.hnsw!.setEf(this.efSearch)
  }

  private allocateLabel(id: string): number {
    const existing = this.idToLabel.get(id)
    if (existing !== undefined) return existing
    const label = this.nextLabel++
    this.idToLabel.set(id, label)
    this.labelToId[label] = id
    return label
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.maxElements) return
    while (this.maxElements < needed) this.maxElements *= 2
    this.hnsw!.resizeIndex(this.maxElements)
  }

  private async appendMeta(doc: VectorDoc, label: number): Promise<void> {
    const stored = stripVector(doc, label)
    await appendJsonl(this.metaPath, stored)
  }

  private async rewriteMetadata(): Promise<void> {
    // For the metadata-only patch path. The metadata file is source-of-truth
    // for IDs/labels — we stream-rewrite it rather than rebuild in memory.
    const rows: ReturnType<typeof stripVector>[] = []
    for (const id of this.labelToId) {
      if (!id) continue
      const doc = this.byId.get(id)
      if (!doc) continue
      const label = this.idToLabel.get(id)!
      rows.push(stripVector(doc, label))
    }
    await writeJsonl(this.metaPath, rows)
  }

  private async persistIndex(): Promise<void> {
    if (!this.hnsw) return
    await this.hnsw.writeIndex(this.indexPath)
    await writeJson(this.manifestPath, { ...this.manifest, max_elements: this.maxElements })
  }

  private async bumpManifest(delta: number): Promise<void> {
    this.manifest = {
      ...this.manifest,
      embedder_model: this.embedder.model,
      dimension: this.embedder.dimension,
      doc_count: Math.max(0, this.manifest.doc_count + delta),
      last_updated: new Date().toISOString(),
    }
    await writeJson(this.manifestPath, { ...this.manifest, max_elements: this.maxElements })
  }

  private async loadMetadata(): Promise<void> {
    if (!(await fileExists(this.metaPath))) return
    const docs: Array<StoredMeta> = []
    await forEachJsonl<StoredMeta>(this.metaPath, (row) => {
      docs.push(row)
    })
    for (const m of docs) {
      const doc: VectorDoc = {
        id: m.id,
        source: m.source,
        chunk_id: m.chunk_id,
        text: m.text,
        vector: [], // vectors live in the HNSW index; restored only when needed
        metadata: m.metadata,
      }
      this.byId.set(m.id, doc)
      this.idToLabel.set(m.id, m.label)
      this.labelToId[m.label] = m.id
      if (m.label >= this.nextLabel) this.nextLabel = m.label + 1
    }
  }
}

interface StoredMeta {
  id: string
  source: string
  chunk_id: string
  text: string
  metadata: VectorMetadata
  label: number
}

function stripVector(doc: VectorDoc, label: number): StoredMeta {
  return {
    id: doc.id,
    source: doc.source,
    chunk_id: doc.chunk_id,
    text: doc.text,
    metadata: doc.metadata,
    label,
  }
}

function matchesFilter(metadata: VectorMetadata, filter: Partial<VectorMetadata>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined) continue
    const got = metadata[k]
    if (Array.isArray(v)) {
      if (!Array.isArray(got)) return false
      for (const needle of v) if (!got.includes(needle)) return false
    } else if (got !== v) {
      return false
    }
  }
  return true
}

let cachedHnswlib: HnswlibModule | null = null

async function loadHnswlib(): Promise<HnswlibModule> {
  if (cachedHnswlib) return cachedHnswlib
  try {
    const mod = (await import('hnswlib-node')) as unknown as
      | HnswlibModule
      | { default: HnswlibModule }
    cachedHnswlib = (mod as { default?: HnswlibModule }).default ?? (mod as HnswlibModule)
    return cachedHnswlib
  } catch (err) {
    throw new Error(
      `HnswBackend requires the 'hnswlib-node' package — install with: ` +
        `npm install hnswlib-node. (${(err as Error).message})`,
    )
  }
}
