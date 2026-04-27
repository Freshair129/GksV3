---
id: ADR--FILE-BASED-VECTOR
phase: 2
type: adr
status: draft
---

# ADR: File-based Vector Store

We choose JSONL-on-disk over a hosted vector DB for Phase 1 to keep the entire
system offline-capable and single-file-auditable. Trade-off: brute-force
cosine at O(N·d), acceptable for N < 100k.
