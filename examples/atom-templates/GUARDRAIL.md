---
id: GUARDRAIL--<RULE-NAME>
phase: 2
type: guardrail
status: active                  # active | deprecated
severity: critical              # critical | high | medium | low
vault_id: <YOUR-PROJECT>
title: <One-line constraint>
tags: [safety, runtime-enforced]
crosslinks:
  enforces: []                  # POLICY-- / CONSTRAINT-- this rule comes from (Hierarchical Link)
  enforced_by: []               # SKILL-- / MOD-- that check this at runtime (Inverse Link)
  references: []                # ADR-- decisions this implements (Context Link)
  triggered_by: []              # INC-- that led to this guardrail (Resolution Link)
---

# GUARDRAIL — <Title>

## Constraint

State the rule precisely. "Agent must NEVER do X when Y."

## Rationale

Why this constraint exists. Reference the ADR / incident / regulation
that prompted it.

## Detection

How the violation is detected at runtime:
- input check: ...
- post-action audit: ...

## Enforcement

What happens on violation:
- block the action / rollback
- log to audit
- alert on-call
- agent is informed and cannot retry

## Examples

**Triggered:** `<concrete example that hits the rule>`
**Allowed:** `<concrete example that passes>`

## Bypass policy

Who can override (if anyone) and how. If no bypass, state explicitly.
