---
id: FR--<REQ-NAME>
phase: 1
type: fr
status: draft
vault_id: <YOUR-PROJECT>
title: <One-line functional requirement>
tags: [functional]
priority: medium                # low | medium | high | must
crosslinks:
  parent: REQ--<umbrella>       # if part of a larger requirement (Hierarchical Link)
  satisfied_by: []              # FEAT-- / BLUEPRINT-- that implement this (Inverse Link)
  verified_by: []               # AUDIT-- proving this requirement met (Resolution Link)
  governed_by: []               # ADR-- that dictates constraints for this FR (Governance Link)
  references: []                # Contextual background / external docs (Context Link)
---

# FR — <Title>

## Statement

The system **shall** <observable behaviour>. State exactly once,
testable.

## Acceptance criteria

- [ ] <verifiable criterion 1>
- [ ] <verifiable criterion 2>
- [ ] <error case>

## Verification approach

- unit / E2E test referenced in implementing BLUEPRINT
- AUDIT-- expected at sign-off

## Source

- <CONCEPT--PRD section / customer interview / ticket>
