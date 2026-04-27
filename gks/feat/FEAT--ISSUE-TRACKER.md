---
id: FEAT--ISSUE-TRACKER
phase: 2
type: feat
status: stable
vault_id: GKS-CORE
title: Self-hosted issue tracker (light-tier)
tags: [user-facing, ops, issue-tracking]
crosslinks:
  implements: [ADR--EXTENDED-TAXONOMY]
  references: [CONCEPT--MEMORY-STORE]
linked_symbols:
  - { file: "src/issue/store.ts" }
  - { file: "src/issue/types.ts" }
  - { file: "bin/gks.ts", fn: cmdIssue }
---

# FEAT — Self-hosted issue tracker

Replaces Linear / Jira / GitHub Issues for projects that want all
artefacts inside their `gks/` knowledge graph. Issues live in the
**light-governance** tier per ADR-012 — direct write OK,
schema-validated, comments append-only.

## CLI surface (8 subcommands)

```sh
gks issue new "Title" [--priority=…] [--label=…] [--assignee=…]
gks issue list [--status=…] [--priority=…] [--label=…] [--assignee=…] [--json]
gks issue show ID [--json]
gks issue comment ID "TEXT"
gks issue status ID NEW_STATUS
gks issue assign ID ASSIGNEE
gks issue close ID [--resolved-by=ADR-…]
gks issue dashboard [--md]
```

## Acceptance criteria

- [x] Status enum: open / triaged / in_progress / blocked / closed / wontfix
- [x] Priority enum: low / medium / high / urgent
- [x] Auto-disambiguates colliding ids (slug + suffix)
- [x] `closed_at` auto-stamped on close/wontfix transition
- [x] Discussion section append-only, preserves chronological history
- [x] Audit log records every mutation (`issue_create`, `issue_comment`,
      `issue_status_change`, `issue_assign`, `issue_close`)
- [x] List default: active issues only (excludes closed/wontfix)
- [x] `--resolved-by=ADR-…` appends to `crosslinks.resolved_by`

## Storage

`<root>/gks/issues/<ID>.md` — one file per issue; frontmatter mutates
freely; body has `## Description` / `## Reproduction` / `## Discussion`
(append-only) / `## Resolution` sections.

## Out of scope (deferred)

- MCP `gks_issue_*` tools — natural follow-up if there's demand
- Cross-issue link integrity (`blocks` / `blocked_by` graph) — orchestrator
- Issue → INC-- promotion automation — orchestrator
