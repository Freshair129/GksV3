---
proposed_id: ADR--ADD-POC-PREFIX
review_id: rev-manual-001
phase: 2
type: adr
status: raw
proposed_at: 2026-04-30T09:00:00Z
title: Add POC-- prefix — time-boxed hypothesis-test atom (light tier)
tags: [taxonomy, governance, poc, experiment, lifecycle]
crosslinks:
  references:
    - ADR--EXTENDED-TAXONOMY        # 30-prefix taxonomy this extends
    - ADR--DOC-TO-CODE-ENFORCEMENT  # P1→P6 flow that POC sits inside
    - ADR--GKS-STORAGE-ENGINE-SCOPE # "contract surface stays narrow" test
  resolves: []
  superseded_by: []
linked_symbols:
  - { file: src/memory/types.ts, fn: AtomicType }
  - { file: docs/KNOWLEDGE-TYPES.md, fn: cluster-1-implementation-flow }
---

# ADR — Add POC-- prefix (time-boxed hypothesis-test atom)

## Context

The current taxonomy (ADR-012) captures *crystallised* knowledge well —
CONCEPT defines the problem, ADR records the decision, BLUEPRINT plans
the build, AUDIT records the outcome. Knowledge that is **still being
proven** has no first-class home. It is currently spread across four
atoms connected by `crosslinks`:

```
CONCEPT--FOO (## Hypothesis)
   └─ BLUEPRINT--FOO (verification_plan)
        └─ examples/foo/ (the actual experiment code — not an atom)
             └─ AUDIT--FOO (results)
                  └─ ADR--FOO (post-experiment decision)
```

This decomposition has three concrete failure modes observed in this repo:

1. **Zombie POCs.** `examples/memory-os-architecture/` is explicitly
   labelled "Python proof-of-concept" in `README.md` and
   `TECHNICAL-OVERVIEW.md` but has no atom recording its hypothesis,
   time-box, or outcome. Whether it has been validated is unclear from
   the atom graph alone.
2. **No anti-pattern guard.** A "POC" can quietly become production
   code without anyone signing off the validation step. The current
   chain has no enforcement that AUDIT must be reached before
   downstream code lands.
3. **Lifecycle mismatch.** Existing atoms have lifecycles that don't
   describe an experiment: ADR has `proposed → accepted → superseded`,
   BLUEPRINT has none, AUDIT is single-shot. A POC needs
   `open → running → validated | invalidated | abandoned` — a state
   machine no current atom carries.

The HOTFIX-- pattern (ADR-014) demonstrates that **a light-tier atom
with a time-box and a unique lifecycle** is a worked solution to this
shape of problem. POC-- is the same pattern applied to hypothesis-test
artifacts.

## Decision

Add **`POC--`** as a light-tier atom with the following shape:

```yaml
---
id: POC--<NAME>
phase: 1                            # P1 — between CONCEPT and BLUEPRINT
type: poc
status: open | running | validated | invalidated | abandoned
vault_id: <project>
title: <one-line hypothesis>
hypothesis: <what we believe; one paragraph>
acceptance_criteria:                # what proves / disproves it
  - <measurable check>
  - <measurable check>
time_box:
  opened_at: <ISO>
  deadline: <ISO>                   # REQUIRED — POCs must terminate
  closed_at: <ISO | null>
crosslinks:
  derives_from: [CONCEPT--<X>]      # where the hypothesis came from
  produces: [BLUEPRINT--<X>, AUDIT--<X>]   # what the POC writes
  feeds_into: [ADR--<X>]            # the decision after the POC
  references: []
linked_symbols:
  - { file: examples/<name>/, fn: <entrypoint> }
---
```

Place in the **light tier** (next to `ISSUE--` and `HOTFIX--`):

| Tier | Atoms | Governance |
|---|---|---|
| Strict | ADR / BLUEPRINT / CONCEPT / FEAT / FRAME / ENTITY / API / … | inbound → review → promote |
| **Light** | `ISSUE--`, `HOTFIX--`, **`POC--`** | direct write OK; schema-validated; lifecycle-enforced |

## Lifecycle enforcement (CLI mirrors `gks hotfix`)

```sh
gks poc open <name> --hypothesis="..." --deadline=2026-05-15 --root=.
gks poc list --root=.                       # all open POCs + countdown
gks poc list --overdue --root=.             # past deadline, no closure
gks poc close <name> --status=validated|invalidated|abandoned --root=.
```

After `time_box.deadline` the pre-commit hook blocks commits touching
`linked_symbols` paths until POC is closed — same mechanic as HOTFIX
backfill window (ADR-014 §6.4).

## Why a separate prefix beats existing alternatives

| Atom | Captures hypothesis? | Captures lifecycle? | Time-box? | Captures abandonment? |
|---|---|---|---|---|
| CONCEPT-- (`## Hypothesis`) | ✅ partial | ❌ | ❌ | ❌ |
| BLUEPRINT-- + AUDIT-- (chain) | ✅ split | ❌ split across 2 atoms | ❌ | ❌ |
| ADR-- (`status: proposed`) | ⚠️ overlap | ✅ but wrong shape | ❌ | ⚠️ via `rejected` |
| INSIGHT-- | ⚠️ too informal | ❌ | ❌ | ❌ |
| **POC--** | ✅ | ✅ purpose-built | ✅ required | ✅ first-class state |

No existing atom carries `time_box.deadline` or the
`validated/invalidated/abandoned` triad. This is genuinely orthogonal
information — not an alias.

## Consequences

**Positive**

- **Zombie POCs become impossible.** Every POC declares its deadline at
  open-time; the pre-commit hook enforces closure or surfaces overdue.
- **Single retrieval point.** "What POCs are running?" `gks poc list`.
  "Was hypothesis X validated?" `gks lookup POC--X`. Currently this
  needs walking 4 atoms.
- **Pattern reuse.** Tooling, schema validator, CLI shape, and pre-commit
  hook copy directly from HOTFIX--. Marginal implementation cost.
- **Cleaner ADR provenance.** `ADR--FOO` can declare
  `crosslinks.derives_from: [POC--FOO]` and reviewers see the experiment
  the decision rests on.
- **Honest about epistemic state.** Aligns with the
  `examples/memory-os-architecture/` epistemic-status field
  (hypothesis → established → locked) but elevates it to a first-class
  atom.

**Negative**

- **Taxonomy +1 prefix.** ADR-012 + ADR-008 explicitly resist new
  prefixes. We accept this cost on the grounds that POC carries genuine
  new lifecycle, not an alias of existing atoms (see comparison table).
- **CLI surface grows.** `gks poc open / list / close` adds 3 commands.
  Mitigated: same scaffold as `gks hotfix`, near-zero novel logic.
- **Phase placement is arguable.** P1 between CONCEPT and BLUEPRINT
  feels right but is a soft choice; the alternative is P0 alongside IDEA.
  Settling on P1 because POC requires a stated hypothesis (P1) but
  doesn't yet have an implementation plan (P3).
- **Possible misuse as "experimental forever".** Mitigated by required
  `deadline` + overdue-blocker, copied from HOTFIX--.

## Alternatives considered

1. **Tag + status only** (`tags: [poc]`, `status: experimental`).
   *Rejected.* Tags can't enforce time-box; status field on existing
   atoms (ADR `proposed`, BLUEPRINT untyped) doesn't carry
   `validated / invalidated / abandoned` triad. No tooling can hook
   into a tag the way it hooks into a type.

2. **Folder convention only** (`gks/poc/` without a typed atom).
   *Rejected.* Loses uniform schema validation across atoms; breaks
   `atomic_index.jsonl` shape; can't be discovered by `gks recall
   --type=poc`.

3. **Reuse `BLUEPRINT--` with `experimental: true` field.**
   *Rejected.* BLUEPRINT is "YAML implementation plan that microtask
   codegen consumes" — POCs are pre-implementation by definition.
   Mixing them blurs the meaning of BLUEPRINT in the verify-flow chain.

4. **Reuse `INSIGHT--` for hypothesis tracking.**
   *Rejected.* INSIGHT is auto-derived by Consolidator (see ADR-012);
   making it human-authored breaks the "auto vs manual" separation.

5. **Defer until a third lifecycle-bound atom appears.**
   *Rejected.* Two existing precedents (HOTFIX--, ISSUE--) and one
   active gap (memory-os POC) already demonstrate the need. Waiting
   means accumulating more zombie POCs.

## What ships in this ADR

If accepted, this ADR ships alongside (separate PRs):

- `docs/KNOWLEDGE-TYPES.md` — POC entry under Cluster 1 (or new "Cluster 6 — Experimentation")
- `examples/atom-templates/POC.md` — starter template
- `src/memory/types.ts` — add `'poc'` to `AtomicType` literal union
- `src/poc/store.ts` — `PocStore` class (mirrors `HotfixStore`)
- `src/poc/types.ts` — `Poc`, `POC_DEADLINE_REQUIRED`, `isOverdue`
- `bin/gks.ts` — `gks poc open / list / close` subcommands
- `test/poc/store.test.ts` — lifecycle + deadline tests
- Pre-commit hook update — block on overdue POCs touching `linked_symbols` paths

Backfill atom for the existing canonical POC:

- `POC--MEMORY-OS-ARCHITECTURE` — retroactively documents the
  hypothesis behind `examples/memory-os-architecture/` with a closed
  status (`validated`) and crosslinks to ADR-008.

## References

- ADR-012 — Extended atomic taxonomy (the 30-prefix list this extends)
- ADR-014 — Doc-to-code enforcement (P1→P6 flow + HOTFIX precedent)
- ADR-008 — GKS as storage engine ("contract surface stays narrow" test)
- `docs/KNOWLEDGE-TYPES.md` § Cluster 1 — current Implementation Flow
- `examples/atom-templates/HOTFIX.md` — pattern this proposal mirrors
- `examples/memory-os-architecture/README.md` — the unmarked POC this ADR exists to formalise
- `examples/memory-os-architecture/core/memory_os.py:220` — `epistemic_status` precedent (hypothesis → established → locked)
