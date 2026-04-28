---
id: FEAT--<FEATURE-NAME>
phase: 2
type: feat
status: draft                   # draft | stable | deprecated
vault_id: <YOUR-PROJECT>
title: <One-line feature summary>
tags: [user-facing, <area>]
crosslinks:
  implements: []                # FR-- / NFR-- this feature satisfies (Requirement Link)
  satisfies: []                 # Explicitly link to functional/non-functional requirements
  references: []                # CONCEPT-- / ADR-- background context (Context Link)
  governed_by: []               # ADR-- that dictates how this feature is built (Governance Link)
  blueprint: BLUEPRINT--<feature-id> # The implementation plan for this feature (Plan Link)
linked_symbols: []              # files / functions implementing this (Code Citation)
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
