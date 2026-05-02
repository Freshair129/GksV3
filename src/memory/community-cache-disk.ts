/**
 * Disk-persisted community-summary cache (BLUEPRINT--PERSISTED-COMMUNITY).
 *
 * Two classes:
 *   - DiskCommunityCache  : file-per-key, atomic writes, mtime-LRU
 *   - TieredCommunityCache: wraps (memory, disk) and prefers memory
 *
 * Cache key is content-addressed via member body hashes — editing any
 * atom in the community changes the key, so stale entries are simply
 * never read again. No explicit invalidation API.
 */

import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import type { CommunityResult } from './community.js'
import { CommunityCache } from './community.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('community-cache-disk')

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50 MiB
const SCHEMA_VERSION = '1.0.0'

interface CachedEntry {
  schema_version: string
  key: string
  members: string[]
  summary: string
  truncated: boolean
  inputTokensEstimate: number
  generator: string
  membership_breakdown?: CommunityResult['membership_breakdown']
  stored_at: string
}

export interface DiskCommunityCacheOptions {
  /** Directory to store cache files. Created if missing. */
  dir: string
  /** Cap on total directory bytes. Default 50 MiB. */
  maxBytes?: number
}

/**
 * File-per-key cache. Files are named by SHA-256(key).slice(0, 32) to
 * keep filename length bounded. Writes go through a temp file +
 * rename for POSIX atomicity.
 */
export class DiskCommunityCache {
  private readonly dir: string
  private readonly maxBytes: number

  constructor(opts: DiskCommunityCacheOptions) {
    this.dir = resolve(opts.dir)
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  }

  private filePath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32)
    return join(this.dir, `${hash}.json`)
  }

  async get(key: string): Promise<CommunityResult | undefined> {
    const path = this.filePath(key)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    let parsed: CachedEntry
    try {
      parsed = JSON.parse(text) as CachedEntry
    } catch {
      return undefined // treat corrupted file as miss
    }
    if (parsed.schema_version !== SCHEMA_VERSION) return undefined

    // Touch mtime to extend LRU lifetime on reads.
    try {
      const now = new Date()
      await utimes(path, now, now)
    } catch {
      /* best-effort, ignore */
    }

    const result: CommunityResult = {
      members: parsed.members,
      summary: parsed.summary,
      truncated: parsed.truncated,
      cached: true,
      inputTokensEstimate: parsed.inputTokensEstimate,
      generator: parsed.generator,
      ...(parsed.membership_breakdown ? { membership_breakdown: parsed.membership_breakdown } : {}),
    }
    return result
  }

  async set(key: string, result: CommunityResult): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const finalPath = this.filePath(key)
    const tmpPath = `${finalPath}.${randomUUID().slice(0, 8)}.tmp`
    const payload: CachedEntry = {
      schema_version: SCHEMA_VERSION,
      key,
      members: result.members,
      summary: result.summary,
      truncated: result.truncated,
      inputTokensEstimate: result.inputTokensEstimate,
      generator: result.generator,
      ...(result.membership_breakdown ? { membership_breakdown: result.membership_breakdown } : {}),
      stored_at: new Date().toISOString(),
    }
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmpPath, finalPath)
    // Fire-and-forget eviction: never block the set call on it.
    this.evictIfNeeded().catch((err) => {
      log.warn('eviction failed (non-fatal)', { error: (err as Error).message })
    })
  }

  async size(): Promise<number> {
    try {
      const files = await readdir(this.dir)
      return files.filter((f) => f.endsWith('.json')).length
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }
  }

  async clear(): Promise<void> {
    try {
      const files = await readdir(this.dir)
      await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map((f) => rm(join(this.dir, f), { force: true })),
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }

  /**
   * Evict oldest-mtime files until total directory bytes ≤ maxBytes.
   * Single-pass scan; not transactional. If eviction fails the cache
   * keeps working — it just gets bigger than the soft cap.
   */
  private async evictIfNeeded(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return
    }
    const stats = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const p = join(this.dir, f)
          try {
            const s = await stat(p)
            return { p, mtimeMs: s.mtimeMs, size: s.size }
          } catch {
            return null
          }
        }),
    )
    const valid = stats.filter((s): s is NonNullable<typeof s> => s !== null)
    let totalBytes = valid.reduce((acc, s) => acc + s.size, 0)
    if (totalBytes <= this.maxBytes) return

    // Oldest first.
    valid.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const v of valid) {
      if (totalBytes <= this.maxBytes) break
      try {
        await rm(v.p, { force: true })
        totalBytes -= v.size
      } catch {
        /* ignore failed deletes */
      }
    }
  }
}

/**
 * Tiered cache: in-memory hits return immediately; on miss, falls
 * through to the optional disk tier; on disk-hit, populates memory
 * for next call.
 *
 * Implements the same surface as CommunityCache but get/set become
 * async — community.ts awaits them so both sync and async caches
 * compose transparently.
 */
export class TieredCommunityCache {
  constructor(
    private readonly memory: CommunityCache,
    private readonly disk?: DiskCommunityCache,
  ) {}

  async get(key: string): Promise<CommunityResult | undefined> {
    const inMem = this.memory.get(key)
    if (inMem) return inMem
    if (!this.disk) return undefined
    const fromDisk = await this.disk.get(key)
    if (fromDisk) {
      // Promote to memory so next call is fast-path.
      this.memory.set(key, fromDisk)
      return fromDisk
    }
    return undefined
  }

  async set(key: string, result: CommunityResult): Promise<void> {
    this.memory.set(key, result)
    if (this.disk) await this.disk.set(key, result)
  }

  size(): number {
    return this.memory.size()
  }

  clear(): void {
    this.memory.clear()
  }
}
