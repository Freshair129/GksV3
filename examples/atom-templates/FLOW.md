---
id: FLOW--<FLOW-NAME>
phase: 2
type: flow
status: draft
vault_id: <YOUR-PROJECT>
title: <One-line flow summary>
tags: [data-flow|ui-flow|sequence]
crosslinks:
  participants: []              # MOD-- / ENTITY-- / ENDPOINT-- involved (Peer/Actor Link)
  references: []                # ADR-- / FEAT-- background context (Context Link)
  preceded_by: []               # FLOW-- that happens before this one (Sequence Link)
  followed_by: []               # FLOW-- that happens after this one (Sequence Link)
---

# FLOW — <Title>

## Trigger

What initiates this flow? (user action, scheduled job, upstream event)

## Sequence

```
Actor A ──→ Actor B: <message / data>
Actor B ──→ Actor C: <message / data>
                   ←──── <response>
Actor C ──→ Storage: <write>
```

## Failure modes

- if step N fails: <recovery / rollback>
- timeout: <handling>

## See also

- (Obsidian Canvas alternative: `FLOW--<name>.canvas` for visual layout)
