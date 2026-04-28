---
id: HOTFIX--<SHORT-SHA>
phase: 5
type: hotfix
status: stable
created_at: <ISO timestamp>
valid_from: <ISO timestamp>      # = commit time
valid_to: <ISO timestamp>        # = commit time + 48 h (REQUIRED)
linked_symbols:
  - { file: src/affected/file.ts, fn: affectedFn }
crosslinks:
  related_incidents: []          # INC-- if a post-mortem exists (Backlink/Peer Link)
  resolved_by: []                # filled in by backfill atoms (CONCEPT--, ADR--, BLUEPRINT--) (Resolution Link)
  references: []                 # Original ISSUE-- or context for the fix (Context Link)
meta:
  commit_sha: <full SHA>
  ref: <branch / tag>
  reason: <one-line why the bypass>
---

# HOTFIX — <one-line summary of what was fixed>

## Why this exists

This atom is the audit trail for a hotfix that shipped before the normal
P1–P3 atoms (`CONCEPT--`, `ADR--`, `BLUEPRINT--`) existed. It opens a
48-hour backfill window (master-spec §6.4, ADR-014).

## What was fixed

Brief description of the production symptom and the change shipped to
resolve it.

## Backfill checklist (must complete before `valid_to`)

- [ ] `CONCEPT--<NAME>` written and `stable`
- [ ] `ADR--<NAME>` written and `stable` (with `crosslinks.resolves: [HOTFIX--<sha>]`)
- [ ] `BLUEPRINT--<NAME>` written and `stable` (geography matches the actual files touched)
- [ ] `gks verify-flow FEAT--<NAME>` returns exit-0

After `valid_to`, the pre-commit hook blocks any further commit on the
affected files until every box above is checked.
