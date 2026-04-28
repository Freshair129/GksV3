---
id: INC--<INCIDENT-NAME>
phase: 2
type: incident
status: stable                  # post-mortems are stable once written
severity: high                  # critical | high | medium | low
vault_id: <YOUR-PROJECT>
title: <One-line incident summary>
tags: [post-mortem]
occurred_at: <ISO timestamp>
resolved_at: <ISO timestamp>
duration_min: <int>
crosslinks:
  trigger_events: []            # MSP-INC-* raw event log entries (Log Reference)
  related_issues: []            # ISSUE-- this incident touched (Peer/Backlink)
  resolved_by: []               # ADR-- / FEAT-- chosen as remediation (Resolution Link)
  references: []                # Prior incidents or background context (Context Link)
linked_symbols: []              # symbols implicated
---

# INC — <Incident summary>

## Timeline

| Time | Event |
|---|---|
| HH:MM | <detection> |
| HH:MM | <escalation> |
| HH:MM | <mitigation> |
| HH:MM | <full recovery> |

## Impact

- users affected: <count / %>
- duration: <min>
- data loss: <yes/no — explain>
- SLA breach: <yes/no — which SLO-->

## Root cause

What actually caused it. Be precise — "config drift" is not a root cause,
"the deploy script overwrote `MAX_POOL_SIZE` from 200 to 20" is.

## Resolution

What was done to mitigate (immediate) + remediate (durable).

- **immediate:** <what stopped the bleeding>
- **durable:** ADR--<chosen approach>

## Lessons

- what worked: ...
- what didn't: ...
- what we'd do differently: ...

## Action items

- [ ] <ACTION 1> — owner, due date
- [ ] <ACTION 2>
- [ ] add GUARDRAIL--<name> to prevent recurrence (if applicable)
