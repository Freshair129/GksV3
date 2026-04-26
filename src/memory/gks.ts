/**
 * Layer 1 — Atomic (structured, read-only).
 *
 * Contract from BLUEPRINT--memory §layers.atomic:
 *   - source: gks/00_index/atomic_index.jsonl
 *   - exports: loadIndex, lookup, filter
 *   - hot_reload via mtime watch
 *
 * Exact-lookup only. No LLM, no fuzzy matching here — that's what Vector/Obsidian
 * layers are for. Guarantees that when the agent asks for `CONCEPT--XYZ` by ID,
 * it gets the exact canonical note from disk (or null), never a hallucinated close match.
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type {
  AtomicEntry,
  AtomicFilter,
  AtomicHit,
  AtomicNote,
} from './types.js'
import { forEachJsonl } from '../lib/jsonl.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('gks:atomic')

export interface AtomicLayerOptions {
  /** Absolute path to atomic_index.jsonl. */
  indexPath: string
  /**
   * Root to resolve `entry.path` against. Defaults to the grandparent of
   * `indexPath` (i.e. if indexPath is `<gks>/00_index/atomic_index.jsonl`,
   * gksRoot becomes `<gks>`).
   */
  gksRoot?: string
  /** Cache note bodies after first read. Default true. */
  cacheBodies?: boolean
}

export class AtomicLayer {
  private readonly indexPath: string
  private readonly gksRoot: string
  private readonly cacheBodies: boolean

  private entries: AtomicEntry[] = []
  private byId = new Map<string, AtomicEntry>()
  private bodyCache = new Map<string, string>()
  private indexMtimeMs = 0
  private loaded = false

  constructor(opts: AtomicLayerOptions) {
    this.indexPath = resolve(opts.indexPath)
    // Default: <gks>/00_index/atomic_index.jsonl  →  <gks>
    this.gksRoot = resolve(opts.gksRoot ?? resolve(dirname(this.indexPath), '..'))
    this.cacheBodies = opts.cacheBodies ?? true
  }

  /** Load (or hot-reload) the atomic index from disk. */
  async loadIndex(): Promise<AtomicEntry[]> {
    const shouldReload = await this.shouldReload()
    if (!shouldReload && this.loaded) return this.entries

    const entries: AtomicEntry[] = []
    const byId = new Map<string, AtomicEntry>()

    try {
      await forEachJsonl<AtomicEntry>(this.indexPath, (row, lineNo) => {
        if (!row.id) {
          log.warn('skipping row without id', { lineNo, path: this.indexPath })
          return
        }
        if (byId.has(row.id)) {
          log.warn('duplicate atomic id', { id: row.id, lineNo })
          return
        }
        entries.push(row)
        byId.set(row.id, row)
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        log.warn('atomic_index.jsonl not found — starting empty', { path: this.indexPath })
        this.entries = []
        this.byId = new Map()
        this.loaded = true
        this.indexMtimeMs = 0
        return this.entries
      }
      throw err
    }

    this.entries = entries
    this.byId = byId
    this.bodyCache.clear()
    this.loaded = true
    this.indexMtimeMs = (await safeMtime(this.indexPath)) ?? 0

    log.info('atomic index loaded', { count: entries.length, path: this.indexPath })
    return entries
  }

  /**
   * Exact lookup by ID. Returns the full note (frontmatter + body) or null.
   * Guarantees: if the ID exists in the index, we read the canonical file — no
   * approximation. If the ID does not exist, we return null (no hallucination).
   */
  async lookup(id: string): Promise<AtomicNote | null> {
    await this.loadIndex()
    const entry = this.byId.get(id)
    if (!entry) return null

    const body = await this.readBody(entry)
    return { ...entry, body }
  }

  /** Sync, in-memory filter. Requires loadIndex() has been called. */
  filter(query: AtomicFilter): AtomicEntry[] {
    if (!this.loaded) {
      throw new Error('AtomicLayer.filter called before loadIndex(); call loadIndex() first')
    }
    return this.entries.filter((e) => {
      if (query.phase !== undefined && e.phase !== query.phase) return false
      if (query.type !== undefined && e.type !== query.type) return false
      if (query.status !== undefined && e.status !== query.status) return false
      if (query.vault_id !== undefined && e.vault_id !== query.vault_id) return false
      if (query.tag !== undefined && !(e.tags ?? []).includes(query.tag)) return false
      return true
    })
  }

  /**
   * Search by ID — wraps lookup() with a uniform hit shape for MemoryStore.
   * Only returns a hit if the ID is an exact match.
   */
  async searchById(id: string): Promise<AtomicHit | null> {
    const note = await this.lookup(id)
    if (!note) return null
    return { note, score: 1.0, matchedBy: 'id' }
  }

  /**
   * Reverse citation lookup — given a code symbol path like
   * `src/x.ts:foo[:42]`, find every indexed atom whose `linked_symbols`
   * or (for blueprints) `geography` cites that path. Implements
   * ADR-010 — see the ADR for match semantics.
   *
   * O(N) over the in-memory index. Acceptable for hundreds-to-low-
   * thousands of atoms; an inverted index can replace this when we
   * scale past that.
   */
  searchBySymbol(symbolPath: string): AtomicEntry[] {
    if (!this.loaded) {
      throw new Error(
        'AtomicLayer.searchBySymbol called before loadIndex(); call loadIndex() first',
      )
    }
    const q = parseSymbolPath(symbolPath)
    if (!q.file) return []
    return this.entries.filter((e) => entryCitesSymbol(e, q))
  }

  getEntry(id: string): AtomicEntry | undefined {
    return this.byId.get(id)
  }

  size(): number {
    return this.entries.length
  }

  private async shouldReload(): Promise<boolean> {
    if (!this.loaded) return true
    const mtime = await safeMtime(this.indexPath)
    if (mtime == null) return false
    return mtime > this.indexMtimeMs
  }

  private async readBody(entry: AtomicEntry): Promise<string> {
    // Defense-in-depth: even though atomic_index.jsonl is treated as trusted,
    // verify the resolved path stays inside gksRoot. A poisoned index entry
    // with `path: "../../etc/passwd"` would otherwise leak arbitrary files.
    const abs = resolve(this.gksRoot, entry.path)
    const rel = relative(this.gksRoot, abs)
    if (rel.startsWith('..') || resolve(rel) === rel) {
      throw new Error(
        `AtomicLayer: refusing to read '${entry.path}' for ${entry.id} — escapes gksRoot`,
      )
    }
    if (this.cacheBodies) {
      const cached = this.bodyCache.get(entry.id)
      if (cached !== undefined) return cached
    }
    const body = await readFile(abs, 'utf8')
    if (this.cacheBodies) this.bodyCache.set(entry.id, body)
    return body
  }
}

// ─── reverse citation lookup helpers (ADR-010) ─────────────────────────

interface ParsedSymbol {
  file: string
  fn?: string
  line?: number
}

function parseSymbolPath(s: string): ParsedSymbol {
  const parts = s.split(':')
  const out: ParsedSymbol = { file: parts[0] ?? '' }
  if (parts[1]) out.fn = parts[1]
  if (parts[2]) {
    const n = Number.parseInt(parts[2], 10)
    if (Number.isFinite(n) && n > 0) out.line = n
  }
  return out
}

function entryCitesSymbol(entry: AtomicEntry, q: ParsedSymbol): boolean {
  // Blueprint-style geography: file paths (with optional :fn). Match
  // when the file part agrees — geography is broader by convention.
  for (const g of entry.geography ?? []) {
    const [gFile] = g.split(':')
    if (gFile === q.file) return true
  }

  // linked_symbols: explicit { file, fn?, line? } records.
  for (const ls of entry.linked_symbols ?? []) {
    if (ls.file !== q.file) continue
    // Atom missing fn ⇒ atom covers whole file ⇒ match any query in that file
    if (ls.fn === undefined) return true
    // Query missing fn ⇒ query is file-level ⇒ match any fn in that file
    if (q.fn === undefined) return true
    if (ls.fn !== q.fn) continue
    // Line check: only enforce when both sides specify
    if (q.line !== undefined && ls.line !== undefined && ls.line !== q.line) continue
    return true
  }
  return false
}

async function safeMtime(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.mtimeMs
  } catch {
    return null
  }
}

/** Convenience factory — pass just the index path. */
export async function openAtomicLayer(indexPath: string): Promise<AtomicLayer> {
  const layer = new AtomicLayer({ indexPath })
  await layer.loadIndex()
  return layer
}
