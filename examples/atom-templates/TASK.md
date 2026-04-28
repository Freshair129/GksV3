---
id: TASK--<SHORT-NAME>
phase: 4
type: task
status: draft                    # draft | stable | deprecated | invalid
priority: medium                 # low | medium | high
assignee: <MSP-AGT-... or MSP-USR-...>     # optional
created_at: <ISO timestamp>
linked_symbols: []
crosslinks:
  parent_blueprint: [BLUEPRINT--<NAME>]    # required — orphan tasks rejected on propose-inbound
  references: []                            # optional ADR-- / FEAT-- the task implements
  resolves: []                              # optional HOTFIX-- if this task closes a hotfix backfill
---

# TASK — <imperative one-liner>

## Spec

One concern, one feature. ≤ 400-token prompt. The prompt + acceptance
criteria together should fit in a single agent turn.

## Acceptance criteria

- [ ] Criterion 1 (testable, falsifiable)
- [ ] Criterion 2
- [ ] Criterion 3 (≥ 2 required for promotion)

## Geography

Files this task is allowed to touch (subset of parent blueprint's
`geography`). The chain walker (`gks verify-flow`) verifies this stays
within the parent's allowed paths.

```yaml
- file: src/foo.ts
  fn: someFunction
- file: test/foo.test.ts
```

## Notes

Anything the agent needs to know that isn't in the parent blueprint —
edge cases, gotchas, prior conversations.
