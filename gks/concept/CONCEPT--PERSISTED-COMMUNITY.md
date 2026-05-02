---
id: CONCEPT--PERSISTED-COMMUNITY
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Disk-persisted cache for community summaries
crosslinks: {"references":["CONCEPT--MEMORY-STORE"]}
created_at: 2026-05-02T06:21:55.105Z
---

# CONCEPT — Disk-persisted cache for community summaries

## Problem

The current `CommunityCache` (shipped in BLUEPRINT--COMMUNITY-SUMMARIES)
lives entirely in memory — bounded LRU, capped at 64 entries,
discarded when the process exits. That works for an interactive agent
session, but breaks down for:

- **Long-running orchestrators** (MSP, batch agents) that ask the same
  community questions across sessions and pay the LLM call every time.
- **Multi-process scenarios** (parallel agents, build pipelines) that
  each rebuild the cache from scratch.
- **Cold starts** in CI / test environments where any reproducible
  community summary requires a fresh LLM call.

With LLM-backed synthesis costing 2-5 seconds + non-trivial tokens per
call, a persisted cache turns hours of repeated synthesis work into
milliseconds.

## Hypothesis

If `CommunityCache` gets a **disk-backed sibling** (`DiskCommunityCache`)
that:

1. Writes each computed result to `.brain/<ns>/community-cache/<key>.json`
   atomically (write-then-rename),
2. Reads cache entries lazily on `.get()` (no startup cost for unused
   keys),
3. Embeds the **member-id list + member body hashes** into the key so
   stale-content detection is automatic (any atom in the community
   gets edited → key changes → fresh synthesis),

then identical community queries across sessions become a disk read
(~10ms) instead of an LLM call (~2-5s + tokens).

The trade-offs:
- **Disk usage**: ~1KB per cached entry, capped by a configured size
  (default 50MB → ~50K entries) with LRU eviction by file mtime.
- **Cache invalidation surface**: handled by content-addressing the
  key (member set + body hash), not by external invalidation calls.
- **Concurrent writes**: write-then-rename is POSIX-atomic; multiple
  processes can write the same key without corruption.

This is the natural read-path optimisation that ADR-COMMUNITY-SUMMARIES
explicitly deferred ("Persisted community summaries can be a follow-up
if read amplification warrants it") — now we have the use case.
