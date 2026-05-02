---
id: ADR--PERSISTED-COMMUNITY
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Disk-persisted community-summary cache
crosslinks: {"parent_concept":["CONCEPT--PERSISTED-COMMUNITY"],"references":["ADR--COMMUNITY-SUMMARIES"]}
created_at: 2026-05-02T06:21:56.652Z
---

# ADR — Disk-persisted community-summary cache

## Context

Per [[CONCEPT--PERSISTED-COMMUNITY]], the in-memory `CommunityCache`
is sufficient for interactive sessions but loses its work across
process boundaries. We want a disk-backed cache for orchestrator-class
workloads — without giving up the simplicity of the existing in-memory
LRU.

Open questions:
1. **Where on disk?**
2. **What's the cache key?**
3. **Cache invalidation strategy?**
4. **Concurrent-process safety?**
5. **API shape — replace, wrap, or sibling?**

## Decision

### 1. Location

`<root>/.brain/<ns>/community-cache/<key>.json` — same `.brain/` tree
that holds vector stores, episodic memory, and inbound queues. Per-
namespace so multi-tenant deployments don't share entries.

### 2. Cache key (content-addressed)

```
key = sha256(
  sortedMemberIds.join(',')
  + '|' + generatorName
  + '|' + (includeBodies ? 'body' : 'tldr')
  + '|' + mode
  + '|' + threshold
  + '|' + topK
  + '|' + sortedMemberBodyHashes.join(',')
).slice(0, 32)
```

Embedding `sortedMemberBodyHashes` makes invalidation **automatic**:
edit any atom in the community → its body hash changes → the key
changes → a fresh entry is written. The old entry remains until LRU
eviction. This eliminates the explicit invalidation API entirely.

### 3. Concurrency

**Write**: `fs.writeFile(<tmp>) + fs.rename(<tmp>, <final>)` — POSIX-
atomic. Two processes computing the same key end up with one final
file (the second rename wins; both have identical content anyway).

**Read**: lazy per `.get()` call. No global lock needed.

**Eviction**: bounded by total directory size (default 50MB). When
exceeded, drop the oldest files by mtime — single-pass scan, fire-and-
forget so cache writes don't block on eviction.

### 4. API shape — sibling, not replacement

```ts
// Existing in-memory cache (unchanged)
class CommunityCache { ... }

// New disk cache implementing the same surface
class DiskCommunityCache {
  constructor(opts: { dir: string; maxBytes?: number })
  get(key: string): CommunityResult | undefined  // sync via cached read
  set(key: string, result: CommunityResult): void
  // ...same shape as CommunityCache
}

// Composable: prefer in-memory hit, fall through to disk, on disk-hit
// also populate in-memory for next call.
class TieredCommunityCache {
  constructor(memory: CommunityCache, disk: DiskCommunityCache)
  // same interface
}
```

`MemoryStore` accepts an optional `communityCache: CommunityCache |
TieredCommunityCache` in its options. Default stays in-memory only —
disk persistence is opt-in.

### 5. Schema

```jsonc
// .brain/<ns>/community-cache/<key>.json
{
  "schema_version": "1.0.0",
  "key": "<full key>",
  "key_hash": "<hash>",
  "members": [...],
  "summary": "...",
  "truncated": false,
  "inputTokensEstimate": 1234,
  "generator": "llm:qwen2.5...",
  "mode": "structural|semantic|hybrid",
  "membership_breakdown": {...},  // optional
  "stored_at": "2026-05-02T..."
}
```

## Consequences

**Positive:**
- Repeated queries across processes / restarts cost <10ms vs
  seconds + tokens.
- Content-addressing makes invalidation automatic — no separate
  "invalidate" API to keep in sync.
- Fully opt-in — no behavioural change for callers that don't wire
  the disk tier.

**Negative:**
- Disk usage grows up to maxBytes; LRU eviction adds I/O on writes.
- Cache cardinality blowup if callers vary `mode` / `threshold` /
  `topK` heavily (each combo = unique key).
- Ephemeral filesystems (CI runners) get no benefit — by design.

**Schema impact:** new directory under `.brain/<ns>/`. Migrations: none
(cache files are derived data, safe to delete at any time).

## Alternatives considered

1. **Replace in-memory LRU with disk-only.** — *rejected.* Disk reads
   add ~10ms to every hit; in-memory hits are sub-ms. Tiered is the
   right shape.

2. **External cache (Redis / SQLite).** — *rejected.* Adds a runtime
   dependency that GKS doesn't otherwise need. Files-on-disk is good
   enough at the scale we're targeting.

3. **Explicit invalidate API.** — *rejected.* Content-addressing
   makes it unnecessary and removes a source of bugs (forgotten
   invalidations).

4. **Cache the LLM input tokens / response separately** (closer to
   token-level deduping). — *deferred.* Higher complexity, narrower
   wins. Result-level cache covers the common case.
