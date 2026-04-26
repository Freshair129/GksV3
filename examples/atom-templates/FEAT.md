---
id: FEAT--<FEATURE-NAME>
phase: 2
type: feat
status: draft                   # draft | stable | deprecated
vault_id: <YOUR-PROJECT>
title: <One-line feature summary>
tags: [user-facing, <area>]
crosslinks:
  implements: []                # FR-- / NFR-- this feature satisfies
  references: []                # CONCEPT-- / ADR-- background
  blueprint: BLUEPRINT--<feature-id>
linked_symbols: []              # files / functions implementing this
---

# FEAT — <Title>

## User-facing behaviour

When user does X, system Y. Describe in plain language; no implementation
details. Reviewer should be able to write acceptance criteria from this.

## Acceptance criteria

- [ ] <observable behaviour 1>
- [ ] <observable behaviour 2>
- [ ] error case: <what should happen when X fails>

## Out of scope

- <related-but-deferred concerns>

## Open questions

- <any unresolved spec questions>
