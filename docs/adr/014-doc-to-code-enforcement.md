# ADR 014 — Doc-to-code enforcement model

- **Status:** accepted
- **Date:** 2026-04-28
- **Deciders:** core
- **Context tag:** workflow, enforcement, agent-rule, hotfix, msp-gatekeeper

## Context

`FRAMEWORK_MASTER_SPEC.md` §6 prescribes a six-phase doc-to-code flow
that every feature must traverse before code merges:

| Phase | Activity                                  | Primary artifact          |
|-------|-------------------------------------------|---------------------------|
| P1    | Define business need + technical draft    | `CONCEPT--`               |
| P2    | Design structure + API spec               | `ADR--` · `ENTITY--` · `API--` |
| P3    | Plan deep code edits (instruction)        | `BLUEPRINT--`             |
| P4    | Task decomposition                        | `T*.task.yaml`            |
| P5    | Real implementation                       | `src/`                    |
| P6    | Acceptance test + quality check           | `AUDIT--`                 |

§6.3 defines an **Agent Rule** every agent must satisfy before writing
code: locate the `FEAT--`, verify it is `APPROVED`, verify referenced
ADRs are `APPROVED`, otherwise **stop and request one**. §6.4 carves
out a single escape hatch (`HOTFIX` tag, 48-hour backfill window).
§6.5 sketches a three-command CLI surface (`new-feature`,
`verify-flow`, `pre-commit`). §7 defines the MSP Gatekeeper
write-contract that prevents hallucinated frontmatter, duplicate IDs,
broken wikilinks, and SSOT overwrites.

GKS today implements roughly two-thirds of this surface. The atom
**types** are all present (per ADR-012's extended taxonomy), the
**inbound queue** enforces strict-tier review (preventing
hallucination + duplicate IDs + SSOT overwrites), and the **reverse
citation lookup** (ADR-010) closes the bidirectional drift loop. What
is missing is the **chain-walking enforcement** that turns the spec's
six phases into a hard gate.

This ADR records that gap explicitly and decides how to close it
without violating ADR-008 (storage-engine scope) or ADR-009 (peer
subsystem boundary).

## Decision

Implement the master-spec doc-to-code flow as a thin **enforcement
layer over GKS primitives**, not as new storage semantics. Six concrete
gaps are addressed:

### 1. `TASK--` prefix as first-class atom

`T*.task.yaml` becomes a recognised prefix per ADR-012's taxonomy.
Folder `gks/task/`, validated frontmatter (`spec`, `assignee`,
`parent_blueprint`, `acceptance`), light-tier governance (direct write
OK — tasks churn fast and are leaf nodes in the chain). Microtasks are
explicitly **leaf nodes** — they must reference a parent
`BLUEPRINT--`; orphan tasks are rejected on `propose-inbound`.

### 2. `status: APPROVED` gate

Existing `Status` enum is `raw | draft | stable | deprecated |
invalid`. The master spec writes `APPROVED`. Resolution: **`stable` is
the `APPROVED` gate** — same semantics, different word. The ADR records
the alias rather than introducing a new enum value, because adding a
fifth "approved" state alongside `stable` would split the same notion
into two truths. CLI / MCP surfaces accept `--status approved` as input
sugar that maps to `stable`.

### 3. Chain walker — `gks verify-flow <FEAT-ID>`

Walks `crosslinks.references` / `crosslinks.implements` from a `FEAT--`
node and asserts the chain `CONCEPT → ADR → BLUEPRINT → TASK → src`
is complete and every node is `stable`. Reports the first broken edge
with file path + missing-link reason. Exit-1 on failure so it composes
into pre-commit / CI.

### 4. Hotfix escape hatch

Pre-commit hook recognises `HOTFIX` in commit message OR `--hotfix`
flag on `git commit`. On detection:

- write a `HOTFIX--<short-sha>` atom into `gks/inc/` with `valid_to`
  set to **commit-time + 48 h**
- subsequent commits that touch the same files are allowed until
  `valid_to`
- **after `valid_to`**, pre-commit blocks any commit on the affected
  files until the P1–P3 backfill atoms (`CONCEPT--`, `ADR--`,
  `BLUEPRINT--`) are present and `stable`

The hotfix atom is itself part of the chain — the backfill atoms must
reference it via `crosslinks.resolves: [HOTFIX--<sha>]`, which is how
`verify-flow` knows the debt is paid.

### 5. `gks new-feature` scaffolder

One command, four atoms:

```sh
gks new-feature my-feature \
  --concept "Why we need this"          \
  --adr "What we decided"               \
  --blueprint-files src/foo.ts,src/bar.ts
```

Drops candidates in `gks/_inbound/`:

```
CONCEPT--MY-FEATURE.md         (frontmatter + body skeleton)
FEAT--MY-FEATURE.md            (references CONCEPT, ADR)
ADR--MY-FEATURE.md             (template)
BLUEPRINT--MY-FEATURE.yaml     (geography pre-filled)
```

After human review + `gks inbound promote`, the chain is wired and
`verify-flow` returns OK.

### 6. Wikilink integrity check — `gks validate --links`

Walks every atom's `crosslinks.*` and `[[wikilink]]` body references;
asserts each ID resolves to an existing atom. Optional CLI flag rather
than always-on, because deep wikilink chasing is the **orchestrator's**
job per ADR-009 (`msp:validate`). GKS exposes the data + a thin
checker; the orchestrator decides when to run it.

## Scope boundary

These six items are **storage-engine scope** (ADR-008 compliant)
because each one is a primitive over already-existing atom data:

- TASK-- = atom type (storage)
- status alias = enum mapping (storage)
- chain walker = read-only graph traversal over `crosslinks` (storage)
- hotfix atom = bi-temporal atom write (storage)
- new-feature scaffolder = inbound-queue convenience (storage)
- link checker = read-only validation (storage)

What stays **out of GKS**:

- Deciding **when** to run `verify-flow` (CI? pre-commit? both?) →
  orchestrator
- Mapping `verify-flow` failures to **which human** gets paged →
  orchestrator
- 48-hour timer enforcement *across distributed actors* → orchestrator
  (GKS only enforces locally on the committing repo)
- Whether the master-spec phases **apply at all** to a given project →
  user / orchestrator policy

## Consequences

**Positive**

- Master-spec §6 becomes mechanically enforceable, not a doc.
- Agent Rule §6.3 is satisfied by `gks verify-flow <FEAT>` returning
  exit-0; agents check this once instead of walking the chain by hand.
- Hotfix escape hatch §6.4 is auditable — every hotfix leaves an atom
  with a hard 48-h deadline and explicit backfill provenance.
- New-feature scaffolder makes the doc-first loop cheaper than skipping
  it; behaviour follows incentive.

**Negative**

- ~600 LOC + one new prefix + one new CLI command surface.
- `verify-flow` introduces a chain-walk cost on every pre-commit if
  enabled; for projects with deep crosslink graphs, expect 50–200 ms
  hot-path overhead. Cached against the index; invalidate on re-index.
- The `stable = APPROVED` aliasing is documentation debt — agents reading
  master-spec verbatim will look for `APPROVED` and not find it. Mitigated
  by accepting both spellings on the CLI.

## What this ADR does NOT change

- Atom types from ADR-012 — unchanged (only adds `TASK--` to the
  recognised set).
- Strict/light-tier split — unchanged. TASK-- is light-tier.
- Inbound queue mechanics — unchanged.
- `linked_symbols` / `geography` semantics from ADR-010 — unchanged.
- Audit log shape — unchanged. New audit ops added: `verify_flow`,
  `hotfix_open`, `hotfix_close`, `validate_links`.
- ADR-008 storage-engine scope — unchanged. Every item above is a
  primitive over atom data; orchestration timing stays in MSP.

## Alternatives considered

1. **Push everything to MSP / orchestrator.** *Rejected.* The atom
   types, chain walker, and link checker need direct access to atomic
   index + crosslinks. Forcing them through MSP doubles the round-trips
   and re-creates ADR-009's "peer subsystem" problem.

2. **New `approved` enum value alongside `stable`.** *Rejected.* Two
   words for the same state is the SSOT-poisoning pattern this whole
   project exists to prevent. Document the alias once, accept both at
   the boundary.

3. **No `TASK--` prefix; treat `T*.task.yaml` as opaque files outside
   `gks/`.** *Rejected.* Tasks reference blueprints and resolve
   incidents — they need crosslink integrity. Without the prefix, the
   chain walker can't traverse them, and the master-spec P4 phase is
   untraceable.

4. **Defer hotfix escape hatch.** *Rejected.* The 48-hour backfill
   window is the load-bearing concession that makes the rest of the
   regime tolerable. Without it, on-call engineers route around GKS
   during incidents and the SSOT loses trust during the worst possible
   moments. Hotfix atom + timer is a 100-LOC investment that
   disproportionately preserves regime credibility.

5. **`verify-flow` runs on every recall, not on commit.** *Rejected.*
   Read-side enforcement makes the system slow without changing
   behaviour — bad atoms are already in the store. Write-side gating
   (commit + inbound promote) is where the leverage is.

## Implementation plan

Six items, in dependency order:

1. **`TASK--` prefix + `gks/task/`** (~80 LOC) — types.ts, taxonomy
   docs, atom template
2. **`status: stable ↔ approved` aliasing** (~20 LOC) — CLI/MCP input
   normaliser
3. **`gks verify-flow <id>`** (~150 LOC) — graph walk, error formatter,
   CLI subcommand
4. **`HOTFIX--<sha>` atom + pre-commit hook** (~120 LOC) — atom write,
   timer, backfill checker
5. **`gks new-feature` scaffolder** (~120 LOC) — inbound multi-write
6. **`gks validate --links`** (~80 LOC) — wikilink walker + crosslink
   checker

Each item ships as its own PR for granular review. `verify-flow` is
the first integration milestone; the rest plug into it.

## References

- `FRAMEWORK_MASTER_SPEC.md` §6 (Step-by-step logging), §6.3 (Agent
  Rule), §6.4 (Hotfix), §6.5 (CLI Enforcement), §7 (MSP Gatekeeper)
- ADR 008 — storage-engine scope (this ADR honours the boundary)
- ADR 009 — orchestrator pattern (timing decisions stay outside GKS)
- ADR 010 — reverse citation lookup (the read-side primitive
  `verify-flow` builds on)
- ADR 012 — extended taxonomy (TASK-- joins the recognised set)
- `src/memory/types.ts` — `Status` enum, `AtomicEntry.crosslinks`
- `src/memory/audit.ts` — new audit ops added by item 3, 4, 6
