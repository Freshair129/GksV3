/**
 * pgvector backend — production-scale VectorBackend implementation.
 *
 * Drops into MemoryStore via:
 *
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
 *   const store = new MemoryStore({
 *     root,
 *     embedder,
 *     vectorBackend: (name, embedder) => createPgvectorBackend({ pool, name, embedder }),
 *   })
 *
 * Schema lives in ./pgvector.sql — apply with `npm run pg-migrate` before
 * the first add(). Runtime uses HNSW on `vector_cosine_ops`; per-query
 * ef_search is set in search() so callers can tune recall/latency without
 * rebuilding the index.
 *
 * Notable design choices
 *   - One physical table per (database, table_prefix). Per-store rows are
 *     partitioned by the `store` column (atomic / episodic / ...) — keeps
 *     index maintenance simple and lets one DB serve many GKS instances.
 *   - addBatch uses pg-copy-streams (text format) — ~10× faster than INSERT
 *     loop on bulk ingestion paths (re-embed script, benchmark runners).
 *   - patchMetadataMany runs in a single transaction — bi-temporal supersede
 *     stays atomic across N predecessors.
 *   - Manifest is a row in `<table>_manifest`, mirroring the JSONL backend's
 *     _manifest.json so callers get a uniform getManifest() shape.
 */

import type { Pool } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'

import { escapeCopyField, isMissingTable, quoteIdent, withTx } from '../../lib/sql.js'

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
import { createLogger } from '../../lib/logger.js'

const log = createLogger('vector:pgvector')

export interface PgvectorBackendOptions {
  pool: Pool
  embedder: Embedder
  /** Logical store name — distinguishes 'atomic' / 'episodic' rows in the table. */
  name: string
  /**
   * Physical table name. Defaults to 'gks_vector'. Can be overridden per
   * MemoryStore instance to support multi-tenancy in a shared DB.
   */
  table?: string
  /** HNSW ef_search for queries (higher = better recall, slower). Default 40. */
  hnswEfSearch?: number
  /** COPY batch size — flush every N rows. Default 1000. */
  copyBatchSize?: number
}

export function createPgvectorBackend(opts: PgvectorBackendOptions): VectorBackend {
  return new PgvectorBackend(opts)
}

class PgvectorBackend implements VectorBackend {
  readonly name: string
  readonly embedder: Embedder
  private readonly pool: Pool
  private readonly table: string
  private readonly manifestTable: string
  private readonly hnswEfSearch: number
  private readonly copyBatchSize: number

  private manifestCache: VectorManifest | null = null
  private loaded = false

  constructor(opts: PgvectorBackendOptions) {
    this.pool = opts.pool
    this.embedder = opts.embedder
    this.name = opts.name
    this.table = opts.table ?? 'gks_vector'
    this.manifestTable = `${this.table}_manifest`
    // Validate identifiers up front so misconfiguration fails fast at
    // construction, not deep inside the first query.
    quoteIdent(this.table, 'pgvector')
    quoteIdent(this.manifestTable, 'pgvector')
    // Bound-check at construction so the SET LOCAL hnsw.ef_search interpolation
    // can never receive NaN/Infinity/negative values that would either break SQL
    // parsing or pin the planner into a pathological mode.
    const ef = opts.hnswEfSearch ?? 40
    if (!Number.isFinite(ef) || ef < 1 || ef > 10_000) {
      throw new Error(`pgvector: invalid hnswEfSearch ${ef} — must be integer in [1, 10000]`)
    }
    this.hnswEfSearch = Math.floor(ef)
    this.copyBatchSize = opts.copyBatchSize ?? 1000
  }

  async load(): Promise<void> {
    if (this.loaded) return
    // Verify the table exists; surfaces missing-migration errors clearly.
    await this.pool.query(`SELECT 1 FROM ${quoteIdent(this.table)} LIMIT 0`)
    const manifest = await this.fetchManifest()
    this.manifestCache = manifest ?? this.emptyManifest()
    this.loaded = true
    log.info('pgvector backend loaded', {
      store: this.name,
      table: this.table,
      doc_count: this.manifestCache.doc_count,
    })
  }

  size(): number {
    return this.manifestCache?.doc_count ?? 0
  }

  getManifest(): VectorManifest {
    return this.manifestCache ?? this.emptyManifest()
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

    await this.pool.query(
      `INSERT INTO ${quoteIdent(this.table)}
         (id, store, source, chunk_id, text, vector, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb, $8)
       ON CONFLICT (id) DO UPDATE SET
         text = EXCLUDED.text,
         vector = EXCLUDED.vector,
         metadata = EXCLUDED.metadata`,
      [
        doc.id,
        this.name,
        doc.source,
        doc.chunk_id,
        doc.text,
        vectorToPg(vector),
        JSON.stringify(doc.metadata),
        doc.metadata['created_at'],
      ],
    )

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

    // Use COPY for the bulk path. Falls back to plain INSERT if items < a few
    // hundred (COPY has setup overhead that's wasted on small batches).
    if (docs.length < 100) {
      for (const doc of docs) {
        await this.pool.query(
          `INSERT INTO ${quoteIdent(this.table)}
             (id, store, source, chunk_id, text, vector, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb, $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            doc.id, this.name, doc.source, doc.chunk_id, doc.text,
            vectorToPg(doc.vector), JSON.stringify(doc.metadata), doc.metadata['created_at'],
          ],
        )
      }
    } else {
      await this.copyInDocs(docs)
    }

    await this.bumpManifest(docs.length)
    return docs
  }

  async search(
    query: string | number[],
    opts: VectorSearchOptions = {},
  ): Promise<VectorHit[]> {
    await this.ensureLoaded()
    const qvec = typeof query === 'string' ? await this.embedder.embed(query) : query
    if (qvec.length !== this.embedder.dimension) {
      log.warn('search query dim mismatch — returning empty', {
        store: this.name,
        query_dim: qvec.length,
        store_dim: this.embedder.dimension,
      })
      return []
    }

    // Defense-in-depth: clamp to a sane range so a caller passing NaN /
    // Infinity / negative / huge topK can't disturb the LIMIT interpolation
    // or trigger pathological scans. Math.floor of a finite Number cannot
    // produce a SQL-injectable string, but a hard cap is cheap insurance.
    const kRaw = opts.topK ?? 5
    const k = Number.isFinite(kRaw) ? Math.min(10_000, Math.max(1, Math.floor(kRaw))) : 5
    const threshold = opts.scoreThreshold ?? -Infinity

    // Build optional metadata filter clauses. We use containment (@>) on the
    // metadata jsonb so callers can pass partial filters cheaply.
    const params: unknown[] = [vectorToPg(qvec), this.name]
    let where = `store = $2`
    if (opts.filter && Object.keys(opts.filter).length > 0) {
      params.push(JSON.stringify(opts.filter))
      where += ` AND metadata @> $${params.length}::jsonb`
    }

    // pgvector uses cosine DISTANCE (1 - cosine sim); we convert to similarity
    // for the caller. Per-query ef_search via SET LOCAL keeps the value scoped
    // to this transaction.
    const sql = `
      WITH q AS (
        SELECT $1::vector AS v
      )
      SELECT id, source, chunk_id, text, vector, metadata, created_at,
             1 - (vector <=> (SELECT v FROM q)) AS score
        FROM ${quoteIdent(this.table)}
       WHERE ${where}
       ORDER BY vector <=> (SELECT v FROM q) ASC
       LIMIT ${k}
    `

    return withTx(this.pool, async (client) => {
      await client.query(`SET LOCAL hnsw.ef_search = ${Math.floor(this.hnswEfSearch)}`)
      const result = await client.query(sql, params)
      const hits: VectorHit[] = []
      for (const row of result.rows as PgRow[]) {
        const score = Number(row.score)
        if (score < threshold) continue
        hits.push({ doc: pgRowToDoc(row), score })
      }
      return hits
    })
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

    return withTx(this.pool, async (client) => {
      const out: Array<VectorDoc | null> = []
      for (const { id, patch } of patches) {
        // jsonb || jsonb performs shallow merge: replaces matching keys,
        // preserves the rest. Matches the in-memory backend semantics.
        const result = await client.query(
          `UPDATE ${quoteIdent(this.table)}
              SET metadata = metadata || $2::jsonb
            WHERE id = $1 AND store = $3
            RETURNING id, source, chunk_id, text, vector, metadata, created_at`,
          [id, JSON.stringify(patch), this.name],
        )
        out.push(result.rows.length > 0 ? pgRowToDoc(result.rows[0] as PgRow) : null)
      }
      return out
    })
  }

  async get(id: string): Promise<VectorDoc | undefined> {
    await this.ensureLoaded()
    const result = await this.pool.query(
      `SELECT id, source, chunk_id, text, vector, metadata, created_at
         FROM ${quoteIdent(this.table)}
        WHERE id = $1 AND store = $2`,
      [id, this.name],
    )
    if (result.rows.length === 0) return undefined
    return pgRowToDoc(result.rows[0] as PgRow)
  }

  /**
   * DB-backed listing — pulls every row for this store. Intentionally returns
   * a frozen array; callers that need streaming should use search() with
   * topK = N or query the table directly.
   *
   * Throws if size() exceeds the safety cap (1M default) — re-embed flows
   * that need this should set GKS_PG_LIST_CAP if they really mean it.
   */
  listDocs(): readonly VectorDoc[] {
    throw new Error(
      `pgvector backend doesn't support synchronous listDocs(). ` +
        `Use the new async listAllDocs() or paginate via search() with explicit topK.`,
    )
  }

  /** Async variant of listDocs(). For the re-embed script + audits. */
  async listAllDocs(opts: { limit?: number } = {}): Promise<VectorDoc[]> {
    await this.ensureLoaded()
    const cap = opts.limit ?? Number(process.env['GKS_PG_LIST_CAP'] ?? 1_000_000)
    const result = await this.pool.query(
      `SELECT id, source, chunk_id, text, vector, metadata, created_at
         FROM ${quoteIdent(this.table)}
        WHERE store = $1
        LIMIT $2`,
      [this.name, cap],
    )
    return (result.rows as PgRow[]).map(pgRowToDoc)
  }

  async clear(): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${quoteIdent(this.table)} WHERE store = $1`,
      [this.name],
    )
    await this.pool.query(
      `INSERT INTO ${quoteIdent(this.manifestTable)} (store, embedder_model, dimension, doc_count)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (store) DO UPDATE SET doc_count = 0, last_updated = now()`,
      [this.name, this.embedder.model, this.embedder.dimension],
    )
    this.manifestCache = this.emptyManifest()
  }

  async setFileHash(relPath: string, hash: string): Promise<void> {
    await this.ensureLoaded()
    await this.pool.query(
      `INSERT INTO ${quoteIdent(this.manifestTable)} (store, embedder_model, dimension, file_hashes)
       VALUES ($1, $2, $3, jsonb_build_object($4::text, $5::text))
       ON CONFLICT (store) DO UPDATE SET
         file_hashes = ${quoteIdent(this.manifestTable)}.file_hashes || jsonb_build_object($4::text, $5::text),
         last_updated = now()`,
      [this.name, this.embedder.model, this.embedder.dimension, relPath, hash],
    )
    if (this.manifestCache) {
      this.manifestCache = {
        ...this.manifestCache,
        file_hashes: { ...this.manifestCache.file_hashes, [relPath]: hash },
        last_updated: new Date().toISOString(),
      }
    }
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

  private async fetchManifest(): Promise<VectorManifest | null> {
    try {
      const result = await this.pool.query(
        `SELECT embedder_model, dimension, doc_count, last_updated, file_hashes
           FROM ${quoteIdent(this.manifestTable)}
          WHERE store = $1`,
        [this.name],
      )
      if (result.rows.length === 0) return null
      const r = result.rows[0] as {
        embedder_model: string
        dimension: number
        doc_count: number
        last_updated: Date | string
        file_hashes: Record<string, string>
      }
      return {
        embedder_model: r.embedder_model,
        dimension: r.dimension,
        doc_count: r.doc_count,
        last_updated:
          r.last_updated instanceof Date ? r.last_updated.toISOString() : r.last_updated,
        file_hashes: r.file_hashes ?? {},
      }
    } catch (err) {
      // Manifest table missing is a clear "run pg-migrate" signal.
      if (isMissingTable(err)) {
        throw new Error(
          `pgvector manifest table '${this.manifestTable}' not found — ` +
            `run 'npm run pg-migrate' before using the backend.`,
        )
      }
      throw err
    }
  }

  private async bumpManifest(delta: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${quoteIdent(this.manifestTable)} (store, embedder_model, dimension, doc_count)
       VALUES ($1, $2, $3, GREATEST(0, $4::int))
       ON CONFLICT (store) DO UPDATE SET
         embedder_model = EXCLUDED.embedder_model,
         dimension = EXCLUDED.dimension,
         doc_count = ${quoteIdent(this.manifestTable)}.doc_count + $4::int,
         last_updated = now()`,
      [this.name, this.embedder.model, this.embedder.dimension, delta],
    )
    if (this.manifestCache) {
      this.manifestCache = {
        ...this.manifestCache,
        doc_count: Math.max(0, this.manifestCache.doc_count + delta),
        last_updated: new Date().toISOString(),
      }
    }
  }

  private async copyInDocs(docs: VectorDoc[]): Promise<void> {
    // COPY into a temp table, then INSERT…SELECT with ON CONFLICT — the
    // direct `COPY … ON CONFLICT` syntax doesn't exist in Postgres.
    // The CREATE TEMP TABLE has to live INSIDE the txn or `ON COMMIT DROP`
    // would fire at the implicit per-statement commit and we'd COPY into
    // a table that no longer exists.
    const tmp = `tmp_gks_${process.pid}_${Date.now()}`
    await withTx(this.pool, async (client) => {
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmp)} (LIKE ${quoteIdent(this.table)} INCLUDING DEFAULTS) ON COMMIT DROP`,
      )
      const stream = client.query(
        copyFrom(
          `COPY ${quoteIdent(tmp)} (id, store, source, chunk_id, text, vector, metadata, created_at) ` +
            `FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\\\N')`,
        ),
      )
      const source = Readable.from(this.copyRowGenerator(docs))
      await pipeline(source, stream)
      await client.query(
        `INSERT INTO ${quoteIdent(this.table)}
           SELECT * FROM ${quoteIdent(tmp)}
         ON CONFLICT (id) DO NOTHING`,
      )
    })
  }

  private *copyRowGenerator(docs: VectorDoc[]): Generator<string> {
    // COPY text format: tab-separated, \n-terminated. Embedded \, tab, newline,
    // CR are escaped per the COPY spec. JSON + vector are safe text.
    for (const d of docs) {
      const cols = [
        d.id,
        this.name,
        d.source,
        d.chunk_id,
        d.text,
        vectorToPg(d.vector),
        JSON.stringify(d.metadata),
        String(d.metadata['created_at'] ?? new Date().toISOString()),
      ]
      yield cols.map(escapeCopyField).join('\t') + '\n'
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

interface PgRow {
  id: string
  source: string
  chunk_id: string
  text: string
  vector: string | number[]
  metadata: Record<string, unknown>
  created_at: Date | string
  score?: number
}

function pgRowToDoc(row: PgRow): VectorDoc {
  return {
    id: row.id,
    source: row.source,
    chunk_id: row.chunk_id,
    text: row.text,
    vector: pgToVector(row.vector),
    metadata: row.metadata ?? {},
  }
}

/** Format a number[] as the pgvector text literal "[1,2,3]". */
export function vectorToPg(v: readonly number[]): string {
  return '[' + v.join(',') + ']'
}

/** Parse pgvector's "[1,2,3]" text response back to number[]. */
export function pgToVector(v: string | number[]): number[] {
  if (Array.isArray(v)) return v
  const trimmed = v.replace(/^\[|\]$/g, '')
  if (!trimmed) return []
  return trimmed.split(',').map(Number)
}

