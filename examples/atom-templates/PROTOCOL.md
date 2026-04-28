---
id: PROTOCOL--<NAME>
phase: 2
type: protocol
status: draft
vault_id: <YOUR-PROJECT>
title: <One-line protocol summary>
tags: [interaction-contract]
participants: [agent, system, ...]
crosslinks:
  used_by: []                   # SKILL-- / MOD-- that depend on this (Inverse Link)
  references: []                # ADR-- / FEAT-- background context (Context Link)
  governed_by: []               # GUARDRAIL-- limiting this protocol (Governance Link)
---

# PROTOCOL — <Title>

## Participants

- **<role A>** — <responsibility>
- **<role B>** — <responsibility>

## Sequence

```
1. <role A> ──→ <role B>:  <message + payload schema>
2. <role B> ──→ <role A>:  <response schema>
3. ...
```

## Invariants

- ordering: <strict | unordered>
- idempotency: <yes / no — explain>
- timeout: <seconds>
- retry: <yes — limit; or no>

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| <message lost> | <how detected> | <retry / fail-fast> |

## Versioning

How is the protocol versioned. What's the upgrade story.

## See also

- <related PROTOCOL-- / API-->
