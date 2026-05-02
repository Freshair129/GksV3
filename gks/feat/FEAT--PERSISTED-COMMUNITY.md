---
id: FEAT--PERSISTED-COMMUNITY
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Disk-persisted community cache
crosslinks: {"parent_concept":["CONCEPT--PERSISTED-COMMUNITY"],"parent_adr":["ADR--PERSISTED-COMMUNITY"],"parent_blueprint":["BLUEPRINT--PERSISTED-COMMUNITY"]}
linked_symbols:
  - {"file":"src/memory/community-cache-disk.ts","fn":"DiskCommunityCache"}
  - {"file":"src/memory/community-cache-disk.ts","fn":"TieredCommunityCache"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore"}
created_at: 2026-05-02T06:21:59.747Z
---

# FEAT — Disk-persisted community cache

## User-facing behaviour

> Given an orchestrator that opts in via `new MemoryStore({ ...,
> communityCache: { persistDir: '<path>' } })`,
> when it calls `summarizeCommunity` for a community it has computed
> before in a previous process,
> then GKS reads the cached result from disk in <10ms instead of
> invoking the LLM generator. The result has `cached: true`.

> Given an atom in the cached community gets edited (body changes),
> when the next `summarizeCommunity` call runs,
> then the cache key changes (because member body hashes change), the
> stale entry is ignored, and a fresh synthesis runs.

> Given a caller without `communityCache.persistDir` set,
> when summarizeCommunity runs,
> then behaviour is byte-identical to the in-memory-only path (V1
> shipped earlier in this branch).

## Acceptance criteria

- [ ] **AC1**: `src/memory/community-cache-disk.ts` exports
      `DiskCommunityCache` + `TieredCommunityCache` per the BLUEPRINT
      shape.
- [ ] **AC2**: `DiskCommunityCache.set(key, result)` writes via
      `fs.writeFile(<tmp>) + fs.rename(<tmp>, <final>)` (POSIX-atomic).
- [ ] **AC3**: Cache file schema includes `schema_version`, `members`,
      `summary`, `mode`, `membership_breakdown` (when present),
      `stored_at`.
- [ ] **AC4**: `summarizeCommunity` cache key includes
      `sortedMemberBodyHashes` so editing any member atom auto-
      invalidates without an explicit invalidation API.
- [ ] **AC5**: `DiskCommunityCache.get(key)` returns `undefined` (not
      throws) on missing file, parse error, or schema mismatch.
- [ ] **AC6**: LRU eviction by mtime when total directory size exceeds
      `maxBytes` (default 50 MiB). Eviction is fire-and-forget — does
      not block the set() call.
- [ ] **AC7**: `TieredCommunityCache` prefers in-memory; on disk-hit
      promotes the entry into memory for next call.
- [ ] **AC8**: `MemoryStoreOptions.communityCache.persistDir` (when
      set) automatically wires `TieredCommunityCache(memory, disk)`
      into `MemoryStore`. Default behaviour (no field) stays
      in-memory-only.
- [ ] **AC9**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests in `test/memory/community-cache-disk.test.ts`.

## Out of scope

- Cross-process file locking (POSIX rename atomicity is sufficient).
- TTL-based eviction (mtime LRU is enough; explicit TTL adds clock-
  drift risk).
- Compression of cached entries (entries are small; not worth it).
- Cache warming / pre-population on startup (lazy load is the right
  default for cold-start latency).
- A `gks community cache` CLI for inspect / clear (separate follow-up).
