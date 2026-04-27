---
id: CONCEPT--MEMORY-STORE
phase: 2
type: concept
status: stable
vault_id: GKS-CORE
title: MemoryStore — the unified four-layer façade
tags: [architecture, core, api]
crosslinks:
  references: [FRAME--FOUR-LAYERS, FEAT--LOOKUP-BY-SYMBOL]
linked_symbols:
  - { file: "src/memory/index.ts" }
  - { file: "src/memory/api.ts", fn: retain }
  - { file: "src/memory/api.ts", fn: recall }
  - { file: "src/memory/api.ts", fn: reflect }
---

# CONCEPT — MemoryStore

`MemoryStore` is GKS's single TS façade. Behind it: four cooperating
storage layers (Atomic, Vector, Episodic, Obsidian) plus cross-cutting
infrastructure (audit, cost, telemetry, retry, circuit-breaker, schema
versioning).

## Three verbs

`retain(content, metadata)` — write a fact with bi-temporal versioning
+ namespace-scoped conflict detection.

`recall(query, opts)` — multi-source parallel retrieval with dedup +
optional rerank + max-total cap.

`reflect(input)` — run the deterministic Three-Gate Consolidator
(LLM-pluggable) over a session trace; produce episodic summary +
candidate atoms for the inbound queue.

## Helpers

- `lookup(id)` — exact-id atomic lookup, never approximates
- `lookupBySymbol(path)` — reverse citation (ADR-010)
- `proposeInbound(artifact)` — only authorised path to candidate atoms
- `appendTrace(sessionId, step)` — session lifecycle

## What it doesn't do

- No Memory OS / consolidation timing (orchestrator's job per ADR-008)
- No code AST / call graph (peer subsystem's job per ADR-009)
- No workflow gates (CI / process layer)

`MemoryStore` is **paradigm-agnostic** — works equally for single-tenant
CLI agents, multi-tenant SaaS, MSP-shaped Memory OS layered above, or
research projects with custom consolidation cascades.
