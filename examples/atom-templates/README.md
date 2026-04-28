# Atom templates

Starter `.md` templates per prefix from
[`docs/KNOWLEDGE-TYPES.md`](../../docs/KNOWLEDGE-TYPES.md).

Each template is the **minimum viable shape** for that atom type:
required frontmatter + recommended frontmatter + body skeleton with
section headings. Copy → fill in → propose via the inbound queue
(`gks propose-inbound …`) or write directly into `gks/issues/` for
ISSUE-- (light-governance tier per ADR-012).

## Available templates

### Implementation flow
- [`ADR.md`](./ADR.md) — architecture decision
- [`FEAT.md`](./FEAT.md) — feature spec
- [`ALGO.md`](./ALGO.md) — algorithm
- [`FLOW.md`](./FLOW.md) — data / UI flow
- [`ENTITY.md`](./ENTITY.md) — data schema
- [`BLUEPRINT.yaml`](./BLUEPRINT.yaml) — implementation plan (YAML, not MD)
- [`AUDIT.md`](./AUDIT.md) — verification report

### Agent governance
- [`SKILL.md`](./SKILL.md) — agent capability
- [`PROTOCOL.md`](./PROTOCOL.md) — interaction contract
- [`GUARDRAIL.md`](./GUARDRAIL.md) — runtime-enforced policy

### Requirements engineering
- [`FR.md`](./FR.md) — functional requirement
- [`NFR.md`](./NFR.md) — non-functional requirement

### Ops governance
- [`INC.md`](./INC.md) — incident post-mortem
- [`ISSUE.md`](./ISSUE.md) — live issue (light-governance)
- [`HOTFIX.md`](./HOTFIX.md) — hotfix escape hatch (48h backfill window, ADR-014)
- [`RISK.md`](./RISK.md) — risk + mitigation
- [`RUNBOOK.md`](./RUNBOOK.md) — operational response guide
- [`SLO.md`](./SLO.md) — service-level objective

## Conventions

- **`id`** must match `^[A-Z][A-Z0-9_]*--[A-Z0-9][A-Z0-9_-]*$`
- **`phase`** must be an integer 0-5
- **`type`** must match the prefix lowercased (`ADR-- → type: adr`)
- **`status`** initial value depends on the cluster:
  - Implementation: `draft` → `stable` (after promote)
  - Issues: `open` (template default) → `triaged` → `in_progress` → `closed`
  - Decisions: `proposed` → `accepted` / `rejected`
- **`linked_symbols`** + **`geography`** — see ADR-010 for cross-reference semantics

## See also

- [`docs/KNOWLEDGE-TYPES.md`](../../docs/KNOWLEDGE-TYPES.md) — full reference
- [`docs/adr/012-extended-taxonomy.md`](../../docs/adr/012-extended-taxonomy.md) — why this list exists
- [`docs/adr/010-reverse-citation-lookup.md`](../../docs/adr/010-reverse-citation-lookup.md) — `linked_symbols` semantics
