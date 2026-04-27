---
id: FEAT--LOOKUP-BY-SYMBOL
phase: 2
type: feat
status: stable
vault_id: GKS-CORE
title: Reverse citation lookup — atoms-by-code-path
tags: [user-facing, traceability, drift-detection]
crosslinks:
  implements: [ADR--REVERSE-CITATION-LOOKUP]
  references: [CONCEPT--MEMORY-STORE]
linked_symbols:
  - { file: "src/memory/index.ts", fn: lookupBySymbol }
  - { file: "src/memory/gks.ts", fn: searchBySymbol }
  - { file: "bin/gks.ts", fn: cmdLookupBySymbol }
  - { file: "src/mcp-server/index.ts" }
---

# FEAT — lookupBySymbol

## User-facing behaviour

Given a code path like `src/x.ts:foo[:42]`, return every atom whose
`linked_symbols` (or, for blueprints, `geography`) cites that path.

```sh
gks lookup-by-symbol src/memory/inbound.ts:propose
```

Returns the list of atoms (ID, type, title, path) along with a hit
count. JSON mode: `--json` for machine-readable output.

## Acceptance criteria

- [x] Exact `file:fn` match
- [x] File-only query matches any `fn` in that file
- [x] Atom with file-only citation matches any `fn` query in that file
- [x] Line-level enforced when both sides specify; otherwise relaxed
- [x] No matches → empty array + exit 0 (in CLI)
- [x] Audit log records `lookup_by_symbol` with hit count

## Surfaces

| Surface | Form |
|---|---|
| TS API | `MemoryStore.lookupBySymbol(symbolPath)` |
| CLI | `gks lookup-by-symbol src/x.ts:foo[:line]` (with `--json`) |
| MCP | `gks_lookup_by_symbol` (Zod-strict input) |

## Out of scope

- Symbol-existence verification (orchestrator's job — typically via
  GitNexus `query` or `impact`)
- Wikilink / cross-atom integrity (orchestrator's job — `msp:validate`)
