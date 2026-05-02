---
'@evaai/gks': patch
---

CHANGELOG: drop redundant `[Unreleased]` section after Changesets
activation; document infrastructure that landed alongside v3.6.0 but
wasn't called out in the release notes.

The `[Unreleased]` section was a hold-over from before Changesets was
activated (PR #20 → PR #22 added entries by hand). All of its content
is either:

- already in the v3.6.0 minor entry (POC-- prefix end-to-end including
  `gks_issue_*` MCP tools, `promote-to-adr`, `--timing` flag, doc/code
  drift fixes, stale-comment cleanups) — round-1 changeset rolled them
  in, OR
- internal infra that shipped on the same commit as v3.6.0 but was
  not user-facing enough for a separate changeset (the CHANGELOG.md
  preamble drift after Changesets first ran also lands in this same
  cleanup)

Going forward, every non-trivial PR adds its own changeset and
`[Unreleased]` no longer exists — the bot owns the section now.

Internal-only items rolled up in this patch (full list for posterity):

- `scripts/poc/measure-gate-overhead.ts` — synthetic gate-overhead
  bench used by `POC--POC-OVERDUE-CI-INTEGRATION` for partial
  validation evidence
- `.github/workflows/bench-nightly.yml` — nightly tiny-fixture smoke
  for all three benchmark runners + the gate-overhead bench
- `npm run poc:bench-gate` script entry
- `docs/BENCHMARKS.md` "Tiny-fixture smoke mode (CI)" section
- `CONTRIBUTING.md` "Releases (Changesets)" section + manual-publish
  checklist
- POC body update on `POC--POC-OVERDUE-CI-INTEGRATION` recording the
  synthetic worst-case p95 = 24.5ms (well under the 500ms acceptance
  criterion)
