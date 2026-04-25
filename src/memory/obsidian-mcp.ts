/**
 * Layer 3 — Obsidian (graph + full-text).
 *
 * Contract from BLUEPRINT--memory §layers.obsidian:
 *   transport: mcp_stdio
 *   server_id: obsidian-mcp
 *   features:
 *     - semantic search via REST plugin
 *     - backlink traversal
 *     - tag query
 *     - resolve [[wikilinks]]
 *   caching.ttl_seconds: 120
 *
 * Phase 1 scope: adapter interface + a REST-plugin client + a deterministic
 * mock. The stdio MCP transport itself is added in Phase 2 when we wire in
 * the official MCP SDK; until then, REST gets us the same four capabilities
 * with zero deps.
 *
 * Design
 *   - ObsidianAdapter: the minimum surface the MemoryStore needs. Any client
 *     (REST, MCP-stdio, mock) implements it.
 *   - RestObsidianAdapter: talks to the Local REST API plugin at
 *     https://github.com/coddingtonbear/obsidian-local-rest-api. Honors an
 *     Authorization: Bearer <token>.
 *   - MockObsidianAdapter: in-process, deterministic. Used by tests and
 *     offline environments so MemoryStore.retrieve(source='obsidian') returns
 *     something without needing Obsidian to be running.
 *   - A small TTL cache wraps any adapter (defaults to 120s per BLUEPRINT).
 */

import { normalizeText, redactSecrets, truncate } from '../lib/text.js'
import { METRIC_NAMES, incrementCounter } from '../lib/telemetry.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('obsidian')

export interface ObsidianNote {
  path: string
  title: string
  body: string
  tags: string[]
  backlinks: string[]     // paths of notes that link to this one
  outlinks: string[]      // paths resolved from [[wikilinks]] inside this note
}

export interface ObsidianSearchHit {
  path: string
  title: string
  snippet: string
  score: number
  matchedBy: 'fulltext' | 'semantic' | 'tag' | 'wikilink' | 'backlink'
}

export interface ObsidianAdapter {
  readonly id: string
  ping(): Promise<boolean>
  search(query: string, opts?: { limit?: number }): Promise<ObsidianSearchHit[]>
  resolveWikilink(link: string): Promise<ObsidianNote | null>
  backlinksOf(path: string, opts?: { limit?: number }): Promise<ObsidianSearchHit[]>
  tagQuery(tag: string, opts?: { limit?: number }): Promise<ObsidianSearchHit[]>
}

// ───────────────────────────────────────────────────────── REST adapter

export interface RestObsidianOptions {
  /** e.g. http://127.0.0.1:27123 (Local REST API default). */
  baseUrl: string
  /** Bearer token from the REST plugin settings. */
  apiKey?: string
  /** Timeout (ms) per request. */
  timeoutMs?: number
}

export function createRestObsidianAdapter(opts: RestObsidianOptions): ObsidianAdapter {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.apiKey) headers['authorization'] = `Bearer ${opts.apiKey}`
  const timeoutMs = opts.timeoutMs ?? 3000

  async function get<T>(path: string): Promise<T> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${opts.baseUrl}${path}`, { headers, signal: ctrl.signal })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`obsidian rest ${res.status}: ${truncate(redactSecrets(body), 200)}`)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(t)
    }
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${opts.baseUrl}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`obsidian rest ${res.status}: ${truncate(redactSecrets(txt), 200)}`)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(t)
    }
  }

  return {
    id: 'rest',

    async ping() {
      try {
        await get<{ status?: string }>('/')
        return true
      } catch (err) {
        log.debug('obsidian ping failed', { err: (err as Error).message })
        return false
      }
    },

    async search(query, { limit = 10 } = {}) {
      try {
        // Local REST API exposes /search/simple?query=... for full-text.
        const hits = await get<Array<{ filename: string; score: number; matches?: unknown }>>(
          `/search/simple?query=${encodeURIComponent(query)}&contextLength=200`,
        )
        return hits.slice(0, limit).map((h) => ({
          path: h.filename,
          title: basename(h.filename),
          snippet: summarizeMatches(h.matches),
          score: h.score,
          matchedBy: 'fulltext' as const,
        }))
      } catch (err) {
        log.warn('obsidian search failed', { err: (err as Error).message })
        return []
      }
    },

    async resolveWikilink(link) {
      const path = wikilinkToPath(link)
      try {
        const body = await get<{ path: string; content: string; frontmatter?: Record<string, unknown>; tags?: string[] }>(
          `/vault/${encodeVaultPath(path)}`,
        )
        return {
          path: body.path,
          title: basename(body.path),
          body: body.content,
          tags: body.tags ?? [],
          backlinks: [],
          outlinks: extractWikilinks(body.content),
        }
      } catch (err) {
        log.debug('obsidian wikilink miss', { link, err: (err as Error).message })
        return null
      }
    },

    async backlinksOf(path, { limit = 20 } = {}) {
      try {
        const res = await get<Array<{ filename: string; context?: string }>>(
          `/vault/${encodeVaultPath(path)}/backlinks`,
        )
        return res.slice(0, limit).map((b, i) => ({
          path: b.filename,
          title: basename(b.filename),
          snippet: b.context ?? '',
          score: 1 / (i + 1),
          matchedBy: 'backlink' as const,
        }))
      } catch {
        return []
      }
    },

    async tagQuery(tag, { limit = 20 } = {}) {
      const q = tag.startsWith('#') ? tag : `#${tag}`
      try {
        const hits = await post<Array<{ filename: string; score: number }>>(
          `/search/`,
          { query: q, contextLength: 120 },
        )
        return hits.slice(0, limit).map((h) => ({
          path: h.filename,
          title: basename(h.filename),
          snippet: '',
          score: h.score,
          matchedBy: 'tag' as const,
        }))
      } catch {
        return []
      }
    },
  }
}

function summarizeMatches(matches: unknown): string {
  if (typeof matches === 'string') return matches
  if (Array.isArray(matches)) {
    return matches
      .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
      .join(' … ')
      .slice(0, 240)
  }
  return ''
}

function encodeVaultPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

// ───────────────────────────────────────────────────────── mock adapter

export interface MockVault {
  notes: ObsidianNote[]
}

/**
 * An in-process Obsidian stand-in for tests + offline recall. Resolves
 * wikilinks from the supplied notes array, computes backlinks by scanning
 * outlinks, and does case-insensitive substring search.
 */
export function createMockObsidianAdapter(vault: MockVault): ObsidianAdapter {
  // Build inverse index for backlinks once.
  const backlinkIndex = new Map<string, string[]>()
  for (const note of vault.notes) {
    for (const target of note.outlinks) {
      const arr = backlinkIndex.get(target) ?? []
      if (!arr.includes(note.path)) arr.push(note.path)
      backlinkIndex.set(target, arr)
    }
  }

  function byPath(path: string): ObsidianNote | null {
    return vault.notes.find((n) => n.path === path) ?? null
  }

  return {
    id: 'mock',

    async ping() {
      return true
    },

    async search(query, { limit = 10 } = {}) {
      const q = query.toLowerCase().trim()
      if (!q) return []
      const hits: ObsidianSearchHit[] = []
      for (const note of vault.notes) {
        const hay = (note.title + '\n' + note.body).toLowerCase()
        if (hay.includes(q)) {
          hits.push({
            path: note.path,
            title: note.title,
            snippet: extractContext(note.body, q, 120),
            score: scoreOverlap(note.title + ' ' + note.body, q),
            matchedBy: 'fulltext',
          })
        }
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit)
    },

    async resolveWikilink(link) {
      const target = wikilinkToPath(link)
      return byPath(target) ?? byTitle(vault, target)
    },

    async backlinksOf(path, { limit = 20 } = {}) {
      const sources = backlinkIndex.get(path) ?? []
      return sources.slice(0, limit).map((src, i) => {
        const n = byPath(src)
        return {
          path: src,
          title: n?.title ?? basename(src),
          snippet: n ? extractContext(n.body, basename(path), 120) : '',
          score: 1 / (i + 1),
          matchedBy: 'backlink' as const,
        }
      })
    },

    async tagQuery(tag, { limit = 20 } = {}) {
      const norm = tag.replace(/^#/, '').toLowerCase()
      return vault.notes
        .filter((n) => n.tags.map((t) => t.toLowerCase()).includes(norm))
        .slice(0, limit)
        .map((n, i) => ({
          path: n.path,
          title: n.title,
          snippet: n.body.slice(0, 120),
          score: 1 / (i + 1),
          matchedBy: 'tag' as const,
        }))
    },
  }
}

function byTitle(vault: MockVault, title: string): ObsidianNote | null {
  const t = title.toLowerCase()
  return vault.notes.find((n) => n.title.toLowerCase() === t) ?? null
}

// ───────────────────────────────────────────────────────── caching

export interface CacheOptions {
  ttlSeconds?: number
  /** Hard cap on entry count. LRU eviction once exceeded. Default 1000. */
  maxEntries?: number
}

/**
 * Wrap any adapter with a bounded LRU + TTL cache. Per BLUEPRINT: Obsidian
 * vaults don't change often, so 120s default TTL is fine. The maxEntries cap
 * prevents unbounded growth in long-running server-mode processes — the
 * simplify review flagged this as a slow leak (see ULTRAPLAN H.2 / review M1).
 *
 * Keys are scoped by method + args so a search for "foo" doesn't poison a
 * tagQuery for "foo".
 *
 * LRU strategy: insertion-order Map + delete-on-access-and-reinsert. The
 * standard idiom; O(1) per access, no extra data structure.
 */
export function withCache(
  inner: ObsidianAdapter,
  opts: CacheOptions = {},
): ObsidianAdapter {
  const ttlMs = (opts.ttlSeconds ?? 120) * 1000
  const maxEntries = Math.max(1, opts.maxEntries ?? 1000)
  const cache = new Map<string, { t: number; value: unknown }>()

  function touch(key: string, value: unknown): void {
    cache.set(key, { t: Date.now(), value })
    // Evict LRU when over cap. Map iteration order is insertion order, so the
    // oldest entry sits at the front.
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }

  function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.t < ttlMs) {
      // Reinsert to mark as recently-used.
      cache.delete(key)
      cache.set(key, hit)
      incrementCounter(METRIC_NAMES.cacheHits, 1, { cache: 'obsidian' })
      return Promise.resolve(hit.value as T)
    }
    incrementCounter(METRIC_NAMES.cacheMisses, 1, { cache: 'obsidian' })
    return load().then((value) => {
      touch(key, value)
      return value
    })
  }

  return {
    id: `${inner.id}+cache`,
    ping: () => inner.ping(),
    search: (query, opts2) => remember(`s:${query}:${opts2?.limit ?? ''}`, () => inner.search(query, opts2)),
    resolveWikilink: (link) => remember(`w:${link}`, () => inner.resolveWikilink(link)),
    backlinksOf: (path, opts2) => remember(`b:${path}:${opts2?.limit ?? ''}`, () => inner.backlinksOf(path, opts2)),
    tagQuery: (tag, opts2) => remember(`t:${tag}:${opts2?.limit ?? ''}`, () => inner.tagQuery(tag, opts2)),
  }
}

// ───────────────────────────────────────────────────────── utils

/** [[Note#Heading|Alias]] → "Note" (we ignore heading / alias for resolution). */
export function wikilinkToPath(link: string): string {
  const stripped = link.replace(/^\[\[|\]\]$/g, '')
  const noAlias = stripped.split('|')[0]!
  const noHeading = noAlias.split('#')[0]!
  return noHeading.trim()
}

export function extractWikilinks(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    out.push(m[1]!.trim())
  }
  return [...new Set(out)]
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  const tail = idx === -1 ? p : p.slice(idx + 1)
  return tail.replace(/\.md$/i, '')
}

function extractContext(text: string, needle: string, len: number): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return text.slice(0, len)
  const start = Math.max(0, idx - Math.floor(len / 2))
  return text.slice(start, start + len).replace(/\s+/g, ' ').trim()
}

function scoreOverlap(haystack: string, needle: string): number {
  const hw = new Set(normalizeText(haystack).split(' ').filter((w) => w.length > 1))
  const nw = normalizeText(needle).split(' ').filter((w) => w.length > 1)
  if (nw.length === 0) return 0
  let overlap = 0
  for (const w of nw) if (hw.has(w)) overlap += 1
  return overlap / nw.length
}
