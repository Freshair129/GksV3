# ADR 013 — Atom folders organised by type, not by phase

- **Status:** accepted
- **Date:** 2026-04-27
- **Deciders:** core
- **Context tag:** filesystem-layout, taxonomy, governance

## Context

The original `gks/` directory layout grouped atoms by **phase first**,
then by type:

```
gks/
├── phase1_concept/
│   └── concept/
├── phase2_atomic/
│   ├── adr/
│   ├── feat/
│   ├── algo/
│   └── …
└── phase3_blueprint/
    └── blueprint/
```

The intuition was that the phase number telegraphs "where in the build
pipeline this atom belongs" — useful when the framework's mental model
is the 7-phase assembly line in `FRAMEWORK_MASTER_SPEC.md`.

In practice it produced three problems:

1. **Atoms shift phase.** A `CONCEPT--` written at P1 may be promoted
   to a stable reference cited from P5 code; the file's phase frontmatter
   updates but the folder doesn't, so `gks/phase1_concept/concept/foo.md`
   ends up containing a stable atom whose `phase: 2` no longer matches
   the path. Two truths, one filesystem.

2. **Duplicate type folders.** Both `gks/phase1_concept/concept/` and
   `gks/phase2_atomic/concept/` are valid concept locations.
   "Where does this concept go?" becomes a discovery problem instead
   of a taxonomy problem.

3. **Phase ≠ folder boundary by intent.** `phase` is a planning
   attribute (which Memory OS phase produced this atom). It belongs in
   frontmatter. Folder structure should reflect *what an atom is*, not
   *when it was made*.

## Decision

Flatten the atom layout: **one folder per atom type, no phase
prefix.**

```
gks/
├── 00_index/
│   └── atomic_index.jsonl
├── concept/                       # CONCEPT-- atoms
├── adr/                           # ADR--
├── feat/                          # FEAT--
├── algo/                          # ALGO--
├── flow/                          # FLOW--
├── entity/                        # ENTITY--
├── frame/                         # FRAME--
├── module/                        # MOD--
├── parameters/                    # PARAMS--
├── blueprint/                     # BLUEPRINT--
├── audit/                         # AUDIT--
├── skill/                         # SKILL--
├── protocol/                      # PROTOCOL--
├── guardrail/                     # GUARDRAIL--
├── policy/                        # POLICY--
├── persona/                       # PERSONA--
├── fr/                            # FR--
├── nfr/                           # NFR--
├── constraint/                    # CONSTRAINT--
├── inc/                           # INC--
├── issues/                        # ISSUE-- (light-tier per ADR-012)
├── risk/                          # RISK--
├── runbook/                       # RUNBOOK--
└── slo/                           # SLO--
```

`phase` stays as a frontmatter field on every atom (per
`AtomicEntry.phase: 0..5` in `src/memory/types.ts`). Filtering by
phase still works via `AtomicLayer.filter({ phase: 2 })` — it scans the
in-memory index, not the filesystem.

## Consequences

**Positive**

- **Single canonical location per atom.** "Where does this concept go?"
  is now `gks/concept/`, not "depends on which phase produced it."
- **Atom rename / promotion = frontmatter edit only.** Bumping `phase:
  1` to `phase: 2` doesn't move the file. Re-running `npm run msp:index`
  picks up the change in the index without filesystem churn.
- **Cleaner Obsidian backlink graph.** Cross-references between atoms
  don't depend on which phase folder they live in; backlinks are stable
  across phase transitions.
- **One less question on contributor onboarding.** Type folders are
  obvious; phase prefixes required reading the framework spec.

**Negative**

- **Existing trees need migration.** Anyone with a phase-prefixed
  `gks/` tree must move files. The re-indexer is path-agnostic so
  rebuilding the index after the move is a single command.
- **Blueprints lose visual grouping.** `gks/blueprint/FEAT-001.yaml`
  sits alongside other types instead of in its own phase silo. Trade-off
  accepted — `type` is the discriminator that matters.
- **Consumers reading `gks/00_index/atomic_index.jsonl` see new
  `path` values.** AtomicLayer reads from the index, so downstream
  code is fine; only doc-strings and screenshots need updating.

## Migration recipe

For an existing `gks/` tree:

```sh
# 1. Move atoms to flat type folders.
cd gks
for phase_dir in phase*_*/; do
  for type_dir in "$phase_dir"*/; do
    type=$(basename "$type_dir")
    mkdir -p "$type"
    mv "$type_dir"*.md "$type/" 2>/dev/null || true
  done
done
rmdir phase*_*/* phase*_*/ 2>/dev/null

# 2. Re-index.
npm run msp:index

# 3. Verify atomic_index.jsonl path values now point at type folders.
head gks/00_index/atomic_index.jsonl
```

## What this ADR does NOT change

- `phase` as a frontmatter field — unchanged.
- `AtomicEntry.phase` in `src/memory/types.ts` — unchanged.
- `AtomicLayer.filter({ phase })` semantics — unchanged.
- The 30+ atomic prefixes from ADR-012 — unchanged.
- The strict / light-tier governance split (ADR-012) — unchanged.
- `gks/issues/` continues to be the light-tier directory.

This is purely a **filesystem layout decision** — same atoms, same
governance, same index, different path layout.

## Alternatives considered

1. **Keep phase prefix, add `<type>` symlinks.** *Rejected.*
   Symlinks aren't portable; Obsidian Canvas / GitHub / `git mv` all
   handle them inconsistently. Plus the underlying tree still has the
   ambiguity.

2. **Phase becomes a sub-folder under type** (`gks/concept/phase1/...`).
   *Rejected.* Same problem flipped — atoms that change phase need to
   move, defeating the point.

3. **Year-based** (`gks/2026/concept/...`). *Rejected.* `created_at` is
   already in frontmatter and not the discoverability axis humans use.

4. **Defer until pain.** *Rejected.* The pain showed up immediately
   when documenting `examples/drift-detection/` — the test fixture had
   to encode the phase prefix to match production layout, which made
   the example harder to read for engineers who aren't reading
   FRAMEWORK_MASTER_SPEC alongside.

## References

- `src/memory/gks.ts` — `AtomicLayer.readBody` resolves `entry.path`
  against `gksRoot`; path-agnostic from a code-reading perspective
- `scripts/msp/re-indexer.ts` — walks `gks/**/*.md` regardless of
  folder depth; works on either layout
- `docs/TECHNICAL-OVERVIEW.md` §10 — updated in this PR to show the
  flat layout
- ADR 008 — storage scope (this is a layout convention change, not a
  scope change)
- ADR 012 — extended taxonomy (the 30+ types this folder list mirrors)
