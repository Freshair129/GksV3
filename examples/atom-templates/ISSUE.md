---
id: ISSUE--<SHORT-NAME>
phase: 2
type: issue
status: open                    # open | triaged | in_progress | blocked | closed | wontfix
priority: medium                # low | medium | high | urgent
assignee: <MSP-AGT-... or MSP-USR-...>     # optional initially
reporter: <MSP-USR-...>
labels: []
created_at: <ISO timestamp>
updated_at: <ISO timestamp>
linked_symbols: []
crosslinks:
  related_incidents: []         # INC-- if this issue stems from an incident (Backlink)
  resolved_by: []               # ADR-- / FEAT-- / HOTFIX-- when closing — what fixed it (Forward/Fix Link)
  duplicates_of: []             # ISSUE-- if this is a duplicate (Peer Link)
  blocks: []                    # ISSUE-- this one is blocking (Dependency Link)
  blocked_by: []                # ISSUE-- blocking this one (Dependency Link)
  references: []                # External discussions / logs / relevant background context
---

# ISSUE — <Short title>

## Description

What's the problem? Symptoms, scope, affected components.

## Reproduction

Steps to reproduce (when applicable):
1. ...
2. ...
3. observed: ...
4. expected: ...

## Impact

Who / what is affected. Severity / urgency rationale.

## Discussion

<!-- Append-only chronological — most recent at the bottom.
     Format: ### <ISO timestamp> [identity] <action>
     Status changes are logged here too. -->

### <ISO timestamp> [<MSP-USR-...>] open
First report.

## Resolution

<!-- Filled when status: closed. Reference the ADR / commit / PR
     that resolved it. -->

_(pending)_
