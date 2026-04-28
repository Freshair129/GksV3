---
id: SKILL--<CAPABILITY-NAME>
phase: 2
type: skill
status: draft                   # draft | active | deprecated
vault_id: <YOUR-PROJECT>
title: <One-line capability summary>
tags: [agent-capability]
crosslinks:
  required_tools: []            # MCP tool / function names this skill uses (Dependency/Tool Link)
  guardrails: []                # GUARDRAIL-- that govern this skill (Governance/Constraint Link)
  references: []                # ADR-- justifying its existence (Context Link)
  used_by: []                   # PERSONA-- or other SKILL-- using this (Inverse Link)
---

# SKILL — <Title>

## When to invoke

Describe the trigger — agent should reach for this skill when context
matches X. Be precise enough that the agent's policy can decide reliably
without ambiguity.

## Required tools

- `<tool-name-1>` — <why this skill needs it>
- `<tool-name-2>`

## Behaviour

1. <step 1>
2. <step 2>
3. <step 3>

## Guardrails referenced

- GUARDRAIL--<name> — <why this skill is bound by it>

## Output contract

What this skill returns / writes. Be specific so callers can parse.

## See also

- <related SKILL-- / FEAT-->
