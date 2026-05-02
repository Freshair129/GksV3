/**
 * Tests for DiskCommunityCache + TieredCommunityCache
 * (BLUEPRINT--PERSISTED-COMMUNITY, V1-V7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DiskCommunityCache,
  TieredCommunityCache,
} from '../../src/memory/community-cache-disk.js'
import { CommunityCache } from '../../src/memory/community.js'
import type { CommunityResult } from '../../src/memory/community.js'

function fakeResult(overrides: Partial<CommunityResult> = {}): CommunityResult {
  return {
    members: ['ATOM--A', 'ATOM--B'],
    summary: 'Synth narrative.',
    truncated: false,
    cached: false,
    inputTokensEstimate: 100,
    generator: 'heuristic',
    ...overrides,
  }
}

describe('DiskCommunityCache', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gks-disk-cache-'))
  })

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('V1: roundtrips through disk — fresh instance reads what the first wrote', async () => {
    const a = new DiskCommunityCache({ dir })
    await a.set('key-1', fakeResult({ summary: 'first' }))

    const b = new DiskCommunityCache({ dir })
    const got = await b.get('key-1')
    expect(got).toBeDefined()
    expect(got!.summary).toBe('first')
    expect(got!.members).toEqual(['ATOM--A', 'ATOM--B'])
    expect(got!.cached).toBe(true)
  })

  it('V2: content-addressed key — different keys produce different files', async () => {
    const c = new DiskCommunityCache({ dir })
    await c.set('key-with-hash-X', fakeResult({ summary: 'X-version' }))
    await c.set('key-with-hash-Y', fakeResult({ summary: 'Y-version' }))

    const xRes = await c.get('key-with-hash-X')
    const yRes = await c.get('key-with-hash-Y')
    expect(xRes!.summary).toBe('X-version')
    expect(yRes!.summary).toBe('Y-version')

    const files = await readdir(dir)
    const jsons = files.filter((f) => f.endsWith('.json'))
    expect(jsons).toHaveLength(2)
  })

  it('V3: atomic write — final file always parses as valid JSON', async () => {
    const c = new DiskCommunityCache({ dir })
    // Sequential set() calls all complete cleanly.
    await Promise.all([
      c.set('k1', fakeResult({ summary: 'A' })),
      c.set('k1', fakeResult({ summary: 'B' })),
      c.set('k1', fakeResult({ summary: 'C' })),
    ])
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const text = await readFile(join(dir, files[0]!), 'utf8')
    expect(() => JSON.parse(text)).not.toThrow()
    const parsed = JSON.parse(text) as { summary: string }
    expect(['A', 'B', 'C']).toContain(parsed.summary) // any winner OK
  })

  it('V4: LRU eviction trims to maxBytes', async () => {
    const c = new DiskCommunityCache({ dir, maxBytes: 1024 }) // 1 KiB
    // Each entry is roughly 200-400 bytes; 8 of them blow the 1 KiB cap.
    for (let i = 0; i < 8; i++) {
      await c.set(`k${i}`, fakeResult({ summary: `entry ${i}` }))
      // Stagger mtime so LRU has a clear ordering.
      await new Promise((r) => setTimeout(r, 5))
    }
    // Settle eviction (fire-and-forget in set()).
    await new Promise((r) => setTimeout(r, 100))

    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    let totalBytes = 0
    for (const f of files) {
      const s = await stat(join(dir, f))
      totalBytes += s.size
    }
    // Within reason of the cap — eviction is best-effort + fire-and-forget.
    expect(totalBytes).toBeLessThanOrEqual(1024 * 2) // 2x slack for eviction race
    // At least the most recent entry survived.
    const last = await c.get('k7')
    expect(last).toBeDefined()
  })

  it('V5: corrupted file → get returns undefined (treated as miss, no throw)', async () => {
    const c = new DiskCommunityCache({ dir })
    // Write garbage at the location key 'broken' would map to.
    await c.set('broken', fakeResult())
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    await writeFile(join(dir, files[0]!), 'not valid json{', 'utf8')

    const result = await c.get('broken')
    expect(result).toBeUndefined()
  })

  it('clear() removes all cached files', async () => {
    const c = new DiskCommunityCache({ dir })
    await c.set('a', fakeResult())
    await c.set('b', fakeResult())
    expect(await c.size()).toBe(2)
    await c.clear()
    expect(await c.size()).toBe(0)
  })

  it('size() returns 0 on a non-existent dir without throwing', async () => {
    const c = new DiskCommunityCache({ dir: join(dir, 'never-created') })
    expect(await c.size()).toBe(0)
  })
})

describe('TieredCommunityCache', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gks-tiered-'))
  })

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('V6: in-memory hit returns without touching disk', async () => {
    const memory = new CommunityCache()
    let diskCalls = 0
    const disk = {
      async get() {
        diskCalls++
        return undefined
      },
      async set() {
        diskCalls++
      },
      size: () => 0,
    } as unknown as DiskCommunityCache

    const t = new TieredCommunityCache(memory, disk)
    await t.set('k', fakeResult())
    diskCalls = 0 // reset after set (which writes to both tiers)

    const result = await t.get('k')
    expect(result).toBeDefined()
    expect(diskCalls).toBe(0) // memory hit, disk NOT consulted
  })

  it('V7: empty memory + populated disk → disk hit promotes to memory', async () => {
    const disk = new DiskCommunityCache({ dir })
    await disk.set('k', fakeResult({ summary: 'from disk' }))

    const memory = new CommunityCache()
    const t = new TieredCommunityCache(memory, disk)

    // First call: disk hit (memory empty)
    const first = await t.get('k')
    expect(first!.summary).toBe('from disk')
    expect(first!.cached).toBe(true)

    // Memory should now have the entry — second call hits memory only.
    const inMem = memory.get('k')
    expect(inMem).toBeDefined()
    expect(inMem!.summary).toBe('from disk')
  })

  it('works without a disk tier (memory-only equivalent)', async () => {
    const memory = new CommunityCache()
    const t = new TieredCommunityCache(memory) // no disk

    await t.set('k', fakeResult({ summary: 'memory-only' }))
    const result = await t.get('k')
    expect(result!.summary).toBe('memory-only')
    expect(result!.cached).toBe(true)
  })

  it('size() and clear() proxy to the memory tier', async () => {
    const memory = new CommunityCache()
    const t = new TieredCommunityCache(memory)
    await t.set('a', fakeResult())
    await t.set('b', fakeResult())
    expect(t.size()).toBe(2)
    t.clear()
    expect(t.size()).toBe(0)
  })
})

// ─── Integration with summarizeCommunity (cache key invalidation) ───────

describe('summarizeCommunity + persisted cache invalidation', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gks-cs-persist-'))
  })

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('cache key includes member body hashes — editing a member invalidates', async () => {
    const { summarizeCommunity, CommunityCache } = await import(
      '../../src/memory/community.js'
    )
    const { TieredCommunityCache, DiskCommunityCache } = await import(
      '../../src/memory/community-cache-disk.js'
    )
    const disk = new DiskCommunityCache({ dir })
    const cache = new TieredCommunityCache(new CommunityCache(), disk)

    // In-memory atomic stub. Body changes between calls → hash changes → key changes.
    type Atom = import('../../src/memory/types.js').AtomicEntry
    type Note = import('../../src/memory/types.js').AtomicNote
    const original: Atom = {
      id: 'ATOM--X',
      phase: 1,
      type: 'concept',
      status: 'stable',
      vault_id: 'd',
      path: 'x.md',
    }
    let body = 'Original body content.'
    const atomic: import('../../src/memory/community.js').CommunityAtomic = {
      getEntry: (id) => (id === 'ATOM--X' ? original : undefined),
      async lookup(id) {
        if (id !== 'ATOM--X') return null
        const note: Note = { ...original, body }
        return note
      },
    }

    const r1 = await summarizeCommunity({ atomic, cache }, { seed: 'ATOM--X' })
    expect(r1.cached).toBe(false)

    // Same body → cache hit.
    const r2 = await summarizeCommunity({ atomic, cache }, { seed: 'ATOM--X' })
    expect(r2.cached).toBe(true)

    // Edit body → key changes → fresh result.
    body = 'Edited body content. Something different now.'
    const r3 = await summarizeCommunity({ atomic, cache }, { seed: 'ATOM--X' })
    expect(r3.cached).toBe(false)
  })
})
