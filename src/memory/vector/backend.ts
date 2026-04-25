/**
 * VectorBackend interface — abstracts the persistence layer behind a
 * semantic search API so pgvector / HNSW / DuckDB / Turbopuffer can drop in
 * for the JSONL default without touching callers.
 *
 * Any concrete backend (JsonlVectorStore, PgvectorBackend, HnswBackend, ...)
 * must implement this surface. MemoryStore now accepts either:
 *   - a factory (name) => VectorBackend, in which case the supplied backend
 *     is used for every named store, OR
 *   - nothing, in which case MemoryStore builds JsonlVectorStore-backed
 *     instances at <vectorDir>/<name>.jsonl (back-compat default).
 *
 * The JsonlVectorStore in ./index.ts is the reference implementation; it
 * already conforms to this interface structurally (we're adding the type
 * here, not changing behavior).
 */

import type {
  VectorDoc,
  VectorHit,
  VectorManifest,
  VectorMetadata,
  VectorSearchOptions,
} from '../types.js'
import type { Embedder } from './embedder.js'

export interface VectorBackendAddItem {
  text: string
  metadata: VectorMetadata
  id?: string
  chunkId?: string
  source?: string
}

export interface VectorBackend {
  /** Human-readable name for logs + manifest scoping. */
  readonly name: string
  /** The embedder this backend is pinned to (drives manifest compat). */
  readonly embedder: Embedder

  load(): Promise<void>
  size(): number
  getManifest(): VectorManifest

  add(text: string, metadata: VectorMetadata, opts?: {
    id?: string
    chunkId?: string
    source?: string
  }): Promise<VectorDoc>

  /**
   * Add using a precomputed vector — skips the embedder call. Used by callers
   * (e.g. retain()) that embed once and reuse the vector for both conflict
   * detection and the insert.
   */
  addWithVector(
    text: string,
    vector: number[],
    metadata: VectorMetadata,
    opts?: { id?: string; chunkId?: string; source?: string },
  ): Promise<VectorDoc>

  addBatch(items: VectorBackendAddItem[]): Promise<VectorDoc[]>

  search(query: string | number[], opts?: VectorSearchOptions): Promise<VectorHit[]>

  /**
   * Patch metadata without re-embedding. Required — bi-temporal conflict
   * resolution depends on it (flipping valid_to + superseded_by).
   */
  patchMetadata(id: string, patch: Partial<VectorMetadata>): Promise<VectorDoc | null>

  /**
   * Batch version — apply each (id, patch) and persist once at the end.
   * Callers that invalidate N predecessors at once should use this instead
   * of N patchMetadata() calls, which in the JSONL backend each trigger a
   * full-file rewrite (O(N·docCount) I/O).
   */
  patchMetadataMany(
    patches: ReadonlyArray<{ id: string; patch: Partial<VectorMetadata> }>,
  ): Promise<Array<VectorDoc | null>>

  /**
   * Lookup by ID. Memory-resident backends resolve immediately; DB-backed
   * backends issue a query. Returns undefined for unknown IDs (never throws
   * for a missing row).
   */
  get(id: string): Promise<VectorDoc | undefined>

  clear(): Promise<void>

  /**
   * Snapshot of currently-stored docs (required for full-store introspection:
   * the re-embed script's incremental path, bulk migration tools, audits).
   * In-memory backends return a shallow copy; streaming backends may choose
   * to throw on stores above a documented size.
   */
  listDocs(): readonly VectorDoc[]

  /** Optional — bulk rewrite (used by the re-embed script). */
  rewriteAll?(docs: VectorDoc[]): Promise<void>

  /** Optional — update a file hash in the manifest (used during rebuilds). */
  setFileHash?(relPath: string, hash: string): Promise<void>

  /**
   * Score a query vector against a known stored doc. Used by rerankers and
   * diagnostics. Returns null when the id is unknown.
   */
  scoreAgainst?(queryVec: number[], docId: string): number | null
}

/** Factory signature MemoryStore uses to produce backends on demand. */
export type VectorBackendFactory = (
  name: string,
  embedder: Embedder,
) => Promise<VectorBackend> | VectorBackend
