---
id: AUDIT--FEAT-<NNN>
phase: 6
type: audit
status: in_progress              # in_progress | passed | failed
vault_id: <YOUR-PROJECT>
title: <Audit subject>
tags: [verification]
crosslinks:
  audits: BLUEPRINT--FEAT-<NNN>     # The implementation plan being verified (Plan Link)
  resolves: []                      # FR-- / NFR-- / ISSUE-- / INC-- proven/fixed by this audit (Resolution Link)
  references: []                    # TASK-- / FEAT-- background (Context Link)
  governed_by: []                   # ADR-- / FRAME-- criteria (Governance Link)
audited_at: <ISO timestamp>
auditor: <MSP-AGT-... or MSP-USR-...>
---

# AUDIT — <Subject>

## Scope

What was tested. Reference the blueprint's `verification_plan` items
covered.

## Results

| Check | Status | Notes |
|---|---|---|
| <test 1> | ✓ pass | ... |
| <test 2> | ✗ fail | ... |
| <test 3> | ⚠ warn | ... |

## Drift checks

- doc-to-code drift: ✓ / ✗  (see `gks lookup-by-symbol` output)
- schema validation: ✓ / ✗
- linked_symbols still valid: ✓ / ✗

## Sign-off

- [ ] all blocking failures triaged
- [ ] non-blocking warnings logged as `ISSUE--`
- [ ] ready to merge / deploy
