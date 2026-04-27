---
id: ADR--FLAT-ATOM-LAYOUT
phase: 2
type: adr
status: stable
vault_id: GKS-CORE
title: Atom folders by type, not by phase
tags: [filesystem-layout, taxonomy, governance]
crosslinks:
  references: [ADR--EXTENDED-TAXONOMY, FRAME--FOUR-LAYERS]
linked_symbols:
  - { file: "scripts/msp/re-indexer.ts" }
  - { file: "src/memory/gks.ts", fn: readBody }
---

# ADR — Atom folders by type, not by phase

## Context

The original `gks/` layout grouped atoms phase-first then type-second
(`gks/phase2_atomic/concept/`, `gks/phase3_blueprint/`). Three
problems:

1. Atoms shift phase but folders don't → frontmatter/path mismatch.
2. Duplicate type folders across phases → discovery problem.
3. `phase` is a planning attribute, not a folder boundary.

## Decision

Flatten the layout: one folder per atom **type**, no phase prefix.
`phase` stays in frontmatter (`AtomicEntry.phase: 0..5`); filtering by
phase still works via `AtomicLayer.filter({ phase: 2 })`.

```
gks/{adr,concept,feat,algo,flow,entity,frame,parameters,module,
     blueprint,audit,skill,protocol,guardrail,policy,persona,
     fr,nfr,constraint,inc,risk,runbook,slo,issues}/
```

## Consequences

**Positive** — single canonical location per atom type. Atom
promotion = frontmatter edit only (no file move). Cleaner Obsidian
backlink graph (paths stable across phase transitions).

**Negative** — existing phase-prefixed trees need migration (recipe
in the doc).

## What this does NOT change

- `phase` as a frontmatter field — unchanged
- `AtomicLayer.filter({ phase })` — unchanged
- `AtomicEntry` shape — unchanged
- Strict / light-tier governance split (ADR-012) — unchanged

Pure filesystem-layout decision. AtomicLayer is path-agnostic.

## References

- ADR 012 — extended taxonomy (the 30+ types this folder list mirrors)
- ADR 008 — storage scope (this is convention, not scope change)
