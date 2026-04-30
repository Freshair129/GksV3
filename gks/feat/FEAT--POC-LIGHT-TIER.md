---
id: FEAT--POC-LIGHT-TIER
phase: 2
type: feat
status: stable
vault_id: GKS-CORE
title: Time-boxed POC atom (light-tier hypothesis test)
tags: [user-facing, governance, poc, experiment, lifecycle]
crosslinks:
  implements: [ADR--ADD-POC-PREFIX]
  references: [ADR--EXTENDED-TAXONOMY, ADR--DOC-TO-CODE-ENFORCEMENT, CONCEPT--MEMORY-STORE]
linked_symbols:
  - { file: "src/poc/store.ts" }
  - { file: "src/poc/types.ts" }
  - { file: "bin/gks.ts", fn: cmdPoc }
  - { file: "src/mcp-server/index.ts" }
  - { file: "examples/atom-templates/POC.md" }
  - { file: "examples/drift-detection/hotfix-gate.sh" }
---

# FEAT — Time-boxed POC atom

A first-class atom for **falsifiable experiments with a hard deadline**.
Closes the gap where `examples/<name>/` directories labelled
"proof-of-concept" had no atom recording their hypothesis, deadline, or
outcome. Lives in the **light-governance** tier next to `ISSUE--` and
`HOTFIX--` per ADR-012 + ADR--ADD-POC-PREFIX.

## CLI surface (5 subcommands)

```sh
gks poc open SLUG --hypothesis="…" \
                  --acceptance-criterion="…" --acceptance-criterion="…" \
                  --deadline=ISO [--title="…"] [--file=…] [--derives-from=CONCEPT--…]
gks poc start POC--SLUG                              # open → running
gks poc list [--overdue] [--open]
gks poc close POC--SLUG --resolution=validated|invalidated|abandoned \
                        [--feeds-into=ADR--…] [--produces=AUDIT--…] [--notes="…"]
gks poc check --file=src/x.ts [--file=src/y.ts]      # pre-commit gate
```

## MCP surface (3 tools)

- `gks_poc_open` — strict `z.object` schema; `acceptanceCriteria` requires `min(1)`
- `gks_poc_list` — `overdue` + `openOnly` filters
- `gks_poc_close` — `resolution` is a `z.enum`; conditional crosslink fields

## Acceptance criteria

- [x] Status enum: `open` / `running` / `validated` / `invalidated` / `abandoned`
- [x] `time_box.deadline` is **required** at open — no default; POCs must terminate
- [x] `hypothesis` and `acceptance_criteria` (≥1) are required and validated
- [x] `closed_at` auto-stamped on terminal-status transition
- [x] Audit log records every mutation (`poc_open`, `poc_close`)
- [x] `inbound.promote()` preserves `hypothesis` / `acceptance_criteria` /
      `time_box` / `resolution` end-to-end (inbound → `gks/poc/`)
- [x] Pre-commit gate (`gks poc check --file=…`) exits 1 when any
      overdue POC's `linked_symbols` overlaps the staged paths
- [x] Pre-commit hook (`examples/drift-detection/hotfix-gate.sh`) wires
      `hotfix check` + `poc check` over the same staged file list
- [x] `lookupBySymbol` discovers POC atoms from
      `linked_symbols` (verified: `src/memory/types.ts` query lists
      ADR--ADD-POC-PREFIX through this path)

## Storage

`<root>/gks/poc/POC--<SLUG>.md` — one file per POC; frontmatter carries
the time box + hypothesis + acceptance criteria; body has
`## Hypothesis` / `## Acceptance criteria` / `## Time box` / `## Result`
sections. Files survive `inbound.promote()` round-trip — every custom
field listed above is in the explicit pass-through whitelist.

## Lifecycle gate

```
   open ──► running ──┬─► validated     (acceptance criteria met)
                      ├─► invalidated   (criteria failed; pivot)
                      └─► abandoned     (deprioritised before conclusion)

   any non-terminal status past time_box.deadline:
      → `gks poc check --file=…` exits 1
      → pre-commit hook blocks until `gks poc close` is run
```

This mirrors `HOTFIX--` 48-hour backfill window (ADR-014 §6.4) but with
an operator-supplied deadline rather than a fixed one.

## Why a separate prefix

Carries genuine new lifecycle no existing atom has:

| Atom | Hypothesis | Lifecycle | Time-box | Abandonment |
|---|---|---|---|---|
| `CONCEPT-- ## Hypothesis` | partial | ❌ | ❌ | ❌ |
| `BLUEPRINT--` + `AUDIT--` chain | split | ❌ | ❌ | ❌ |
| `ADR-- status: proposed` | overlap | wrong shape | ❌ | reject only |
| `INSIGHT--` (auto-derived) | informal | ❌ | ❌ | ❌ |
| **`POC--`** | ✅ required | ✅ purpose-built | ✅ required | ✅ first-class |

Survives the ADR-008 / ADR-012 anti-bloat test where `CONCERN--`,
`NOTE--`, `MCP--`, and `HYPOTHESIS--` did not — see
`ADR--ADD-POC-PREFIX § Alternatives considered`.

## Worked example

`POC--MEMORY-OS-ARCHITECTURE` — backfill atom for
`examples/memory-os-architecture/`. Records the hypothesis behind the
Python proof-of-concept that informed ADR-008 (GKS as storage engine)
and ADR-009 (MSP as orchestrator). Status `validated`; all five
acceptance criteria met; closed retroactively.

## Out of scope (deferred)

- LLM-assisted hypothesis quality lint — orchestrator concern (e.g. MSP
  rejecting POCs whose hypothesis isn't falsifiable)
- Auto-promotion `POC-- (validated) → ADR--` scaffolder — tooling, not
  a storage primitive
- Time-series visualisation of POC outcome rates — observability, lives
  outside `src/`
