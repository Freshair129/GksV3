---
id: POC--POC-OVERDUE-CI-INTEGRATION
phase: 1
type: poc
status: open
vault_id: GKS-CORE
title: Verify gks poc check pre-commit gate behaves correctly under real CI flow
hypothesis: |
  The pre-commit gate (examples/drift-detection/hotfix-gate.sh) running
  `gks poc check --file=…` over staged paths reliably blocks commits
  that touch an overdue POC's linked_symbols, with zero false positives
  on normal commits, and adds < 500ms overhead per pre-commit
  invocation. If true, the lifecycle gate is safe to recommend as
  default for projects adopting POC-- light-tier governance; if false,
  we either tighten the matching logic, raise the overhead budget, or
  fall back to a manual `gks poc list --overdue` ritual.
acceptance_criteria:
  - 0 false-positive blocks across ≥50 commits in normal development
    (no overdue POC, hook still passes)
  - 100% true-positive when an overdue POC's linked_symbols overlaps
    the staged paths (hook exits non-zero, prints the POC id and the
    close command)
  - p95 hook overhead < 500ms on a repo with 12 atoms (current size)
  - Error message includes the exact `gks poc close <id> --resolution=…`
    command operators need
  - Gate cleanly handles the 3 storage shapes — empty `gks/poc/`,
    populated with only future-deadline POCs, populated with at least
    one overdue POC
time_box:
  opened_at: 2026-04-30T10:35:00Z
  deadline: 2026-07-15T00:00:00Z
  closed_at: null
crosslinks:
  derives_from: []
  produces: []
  feeds_into: []
  references:
    - ADR--ADD-POC-PREFIX
    - FEAT--POC-LIGHT-TIER
    - ADR--DOC-TO-CODE-ENFORCEMENT
---

# POC — Verify gks poc check pre-commit gate behaves correctly under real CI flow

## Why this exists (worked example)

This is the first **truly running** POC in `gks/poc/` — it's not a
backfill atom (cf. `POC--MEMORY-OS-ARCHITECTURE` which is `validated`).
It demonstrates the `open` lifecycle state shipped with
`ADR--ADD-POC-PREFIX`. The hypothesis is real — the project has a
genuine interest in confirming the gate behaviour before recommending
it as a hard default — but the *primary* purpose right now is to keep
an `open` POC in the repo so future contributors see what the
canonical shape looks like.

If at any point the time_box deadline passes without closure, that's
the dogfood lesson: even the project's own POCs are subject to the
same gate. The hook will not actually block source-tree commits
because no `linked_symbols` are declared (intentional — see below).

## Method

1. Instrument `examples/drift-detection/hotfix-gate.sh` with timing
   measurements (`time` wrapper) over a sample of pre-commit runs.
2. Construct three test scenarios under `test/cli/`:
   - empty `gks/poc/`
   - only future-deadline POCs
   - one overdue POC whose `linked_symbols` overlaps the staged paths
3. Run each scenario through the actual hook (not just the CLI alone)
   to catch any glue-level bugs in the bash wrapper.
4. Capture 50+ commits from regular development, count false positives.
5. Diff the operator-visible error message against the expected
   `gks poc close … --resolution=…` template.

## Why no linked_symbols

If this POC declared `linked_symbols`, then if the deadline passed
without closure, the project's own pre-commit gate would block any
commit on those files until close. For a *demonstration* POC carried
by the canonical repo, that's a footgun. Real project POCs that are
testing a specific code path SHOULD declare `linked_symbols` — that's
where the lifecycle pressure adds value.

The unit tests for the gate already cover the
`linked_symbols`-overlap path with a backdated deadline (see
`test/cli/gks-poc.test.ts > poc check exits 1 with diagnostic …`),
so we have coverage of the core mechanic.

## Interim result — synthetic measurement (2026-04-30)

Per the "rigorous default" guideline, partial evidence is recorded
*before* closure rather than waiting passively for the real-world
data.

`scripts/poc/measure-gate-overhead.ts` (added 2026-04-30) measures
`PocStore.listOverdue()` — the same code path `gks poc check` walks.
Three scenarios across 100 iterations after a 5-iteration warmup:

| Scenario             | n   | p50    | p95    | p99    | max    | mean   |
|----------------------|-----|--------|--------|--------|--------|--------|
| empty `gks/poc/`     | 100 | 0.0ms  | 0.1ms  | 0.2ms  | 0.2ms  | 0.1ms  |
| 50 future-deadline   | 100 | 17.7ms | 24.5ms | 28.4ms | 33.5ms | 18.7ms |
| 50 + 1 overdue       | 100 | 17.4ms | 20.9ms | 21.6ms | 22.7ms | 17.5ms |

**Worst-case p95 = 24.5ms** — 20× under the 500ms acceptance
criterion. Linear scaling with POC count is the expected pattern
(file-per-atom IO).

This evidence covers acceptance criteria #3 (p95 overhead) and
partially #5 (handles the three storage shapes — empty / future-only
/ with-overdue). Criteria #1 (50+ commits without false positives),
#2 (true-positive on overlap), and #4 (error message format) still
need real-world data and are why the POC stays `open` until the
2026-07-15 deadline.

Reproduce:

```sh
npm run poc:bench-gate -- --iterations=100 --poc-count=50
# or:
npx tsx scripts/poc/measure-gate-overhead.ts --iterations=100 --json
```

## Result

(Filled at closure. Expected outcomes:)

- **validated:** all 5 acceptance criteria met → recommend
  `examples/drift-detection/hotfix-gate.sh` as a default install
- **invalidated:** at least one criterion fails → file
  `ADR--POC-GATE-REVISIONS` documenting the necessary changes
- **abandoned:** project priorities shift; close cleanly with
  `gks poc close POC--POC-OVERDUE-CI-INTEGRATION --resolution=abandoned`

## References

- `ADR--ADD-POC-PREFIX` — the proposal this POC tests in real use
- `FEAT--POC-LIGHT-TIER` — the user-facing feature whose gate this
  validates
- `ADR--DOC-TO-CODE-ENFORCEMENT` — the doc-to-code framework this
  pattern fits inside
- `test/cli/gks-poc.test.ts` — unit-level coverage of the same gate
- `examples/drift-detection/hotfix-gate.sh` — the integration this
  validates
