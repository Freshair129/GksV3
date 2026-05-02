---
id: BLUEPRINT--PERSISTED-COMMUNITY
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Disk-persisted community cache
crosslinks: {"parent_adr":["ADR--PERSISTED-COMMUNITY"],"parent_concept":["CONCEPT--PERSISTED-COMMUNITY"]}
linked_symbols:
  - {"file":"src/memory/community.ts","fn":"CommunityCache"}
  - {"file":"src/memory/community-cache-disk.ts","fn":"DiskCommunityCache"}
  - {"file":"src/memory/community-cache-disk.ts","fn":"TieredCommunityCache"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore"}
created_at: 2026-05-02T06:21:58.218Z
---

# BLUEPRINT — Disk-persisted community cache

```yaml
metadata:
  title: "Disk-persisted community-summary cache"
  status: draft

architectural_pattern: |
  Two new classes that share the existing CommunityCache surface:
    - DiskCommunityCache  — file-per-key, atomic writes, mtime-LRU
    - TieredCommunityCache — wraps (in-memory, disk) and prefers memory

  Cache key includes member body hashes for automatic invalidation.
  Opt-in via MemoryStore options.

data_logic: |
  set(key, result):
    1. Compute fileName = sha256(key).slice(0, 32) + '.json'
    2. Write JSON to <dir>/<fileName>.tmp
    3. Rename .tmp → final (POSIX-atomic)
    4. If totalDirBytes > maxBytes, evict oldest by mtime (best-effort)

  get(key):
    1. fileName = sha256(key).slice(0, 32) + '.json'
    2. Read file → JSON.parse → return as CommunityResult (cached: true)
    3. Touch mtime to extend LRU lifetime
    4. Returns undefined on ENOENT or parse error (treats stale entries
       as misses, never throws)

  Tiered get(key):
    - in-memory hit → return immediately
    - disk hit → return AND populate in-memory for next call
    - both miss → return undefined

  Tiered set(key, result):
    - write to in-memory always
    - write to disk if disk tier configured

  summarizeCommunity will compute:
    keyForCache = base_key + '|' + sortedMemberBodyHashes.join(',')
  This is added to community.ts cacheKey() helper.

geography:
  - "src/memory/community.ts"             # extend cacheKey + accept body hashes
  - "src/memory/community-cache-disk.ts"  # NEW: disk + tiered impls
  - "src/memory/index.ts"                 # opt-in wiring on MemoryStore
  - "test/memory/community-cache-disk.test.ts"  # NEW

api_contracts:
  - name: "DiskCommunityCache"
    file: "src/memory/community-cache-disk.ts"
    shape: |
      interface DiskCommunityCacheOptions {
        dir: string
        maxBytes?: number   // default 50 MiB
      }
      class DiskCommunityCache {
        constructor(opts: DiskCommunityCacheOptions)
        get(key: string): Promise<CommunityResult | undefined>
        set(key: string, result: CommunityResult): Promise<void>
        size(): Promise<number>
        clear(): Promise<void>
      }

  - name: "TieredCommunityCache"
    file: "src/memory/community-cache-disk.ts"
    shape: |
      class TieredCommunityCache {
        constructor(memory: CommunityCache, disk?: DiskCommunityCache)
        get(key: string): Promise<CommunityResult | undefined>
        set(key: string, result: CommunityResult): Promise<void>
        // mirrors CommunityCache surface but is async (disk path)
      }

  - name: "MemoryStoreOptions extension"
    file: "src/memory/index.ts"
    shape: |
      interface MemoryStoreOptions {
        // existing fields …
        communityCache?: {
          /** Enable disk-backed tier. Default false (in-memory only). */
          persistDir?: string
          /** Cap on disk usage. Default 50 MiB. */
          maxBytes?: number
        }
      }

  - name: "summarizeCommunity (signature unchanged, key extended)"
    file: "src/memory/community.ts"
    shape: |
      cacheKey() now also incorporates sortedMemberBodyHashes for
      automatic invalidation when any member atom is edited.
      summarizeCommunity becomes async-cache-aware: it awaits
      cache.get/cache.set so the disk tier works.

verification_plan:
  - id: V1-roundtrip
    description: |
      Write a CommunityResult to DiskCommunityCache; create a fresh
      instance pointing at the same dir; get(key) returns the same
      members + summary; cached=true.
  - id: V2-content-addressed-key
    description: |
      Compute key with member body hashes; store; mutate one member's
      body hash; recomputed key differs; old cached entry irrelevant
      (different file). No explicit invalidate needed.
  - id: V3-atomic-write
    description: |
      Concurrent set() calls for the same key from two pseudo-processes
      both succeed; final file has valid JSON content (never partial).
  - id: V4-lru-eviction
    description: |
      Set maxBytes=2KB; write 5 entries of ~1KB each; total dir size
      stays ≤ maxBytes; oldest-mtime files were evicted.
  - id: V5-corrupted-file-graceful
    description: |
      Write garbage to a cache file; get() returns undefined (treats
      as miss), does not throw.
  - id: V6-tiered-prefer-memory
    description: |
      TieredCache: in-memory hit returns without touching disk
      (verified by spying disk.get not called).
  - id: V7-tiered-disk-promotes-to-memory
    description: |
      Empty memory + populated disk: get() returns the disk entry AND
      populates memory; second get() hits memory.

implementation_steps:
  - 1. Implement DiskCommunityCache (atomic write, mtime LRU, JSON
       schema with stored_at).
  - 2. Implement TieredCommunityCache (memory → disk fallthrough).
  - 3. Update community.ts cacheKey() to accept optional bodyHashes;
       update summarizeCommunity to compute + pass them; flip
       cache get/set to await (back-compat-safe — sync caches resolve
       immediately).
  - 4. Wire MemoryStoreOptions.communityCache into MemoryStore
       constructor.
  - 5. Tests V1-V7. Public exports added to src/memory/index.ts.
```
