---
id: ADR--TASK-TRACKING-AT-ORCHESTRATOR
phase: 2
type: adr
status: stable
vault_id: GKS-CORE
title: Task tracking belongs to the orchestrator, not GKS
tags: [scope, taxonomy, lifecycle, msp, supersedes]
crosslinks:
  references: [ADR--EXTENDED-TAXONOMY]
  partially_supersedes: [ADR--DOC-TO-CODE-ENFORCEMENT]
linked_symbols:
  - { file: "src/memory/types.ts", fn: AtomicType }
  - { file: "src/scaffold/new-feature.ts", fn: scaffoldNewFeature }
  - { file: "bin/gks.ts", fn: cmdNewFeature }
---

# ADR — Task tracking belongs to the orchestrator, not GKS

## Context

ADR-014 item 1 added `TASK--` to the atomic taxonomy. ADR-008 places
GKS as a storage engine for **durable knowledge** — atoms with
settling time. Tasks are **execution state**: status churns hourly,
comments accumulate, subtasks decompose recursively, and once shipped
the task itself has zero retrieval value (the durable artefact is
`AUDIT--`). ADR-014's "light-tier" patch fixed governance friction
but not the underlying lifecycle mismatch.

Six months into a real project, `gks/task/` would accumulate hundreds
of completed-task corpses polluting the SSOT.

## Decision

Remove `TASK--` from the recognised atomic taxonomy. Live task /
subtask / microtask state moves to the orchestrator (MSP / evaAI /
Linear / etc., per ADR-009). GKS keeps the durable edges:

- `BLUEPRINT--` — the work's *shape* (file paths, acceptance criteria)
- `AUDIT--` — the work's *outcome* once it closes
- `crosslinks.parent_blueprint` — generic key, any future durable
  child atom can use it; the chain walker still walks it.

Microtasks (`T*.task.yaml`) live at one of three homes:

- `.brain/<ns>/tasks/<slug>/` (self-hosted) — written by
  `gks new-feature --task-tracker=local`
- `msp/projects/<id>/tasks/` (MSP-layered) — orchestrator API owns the writes
- External tracker (Linear/Jira/Asana) — `BLUEPRINT.meta` may carry a URL

## Consequences

**Positive** — atom lifecycle stays clean; SSOT doesn't accumulate
completed-task corpses; the `BLUEPRINT.geography → AUDIT--` seam works
identically across self-hosted, MSP, and external trackers; one fewer
prefix for new contributors.

**Negative** — minor doc churn (KNOWLEDGE-TYPES, WORKFLOW, ADR-014
item 1, scaffolder). Master-spec wording references `T*.task.yaml`;
this ADR records that those files live outside `gks/`.

## What this does NOT change

- ADR-008 / ADR-009 — this ADR strengthens enforcement of both.
- ADR-014 items 2, 3, 4, 5, 6 — unchanged. Only item 1 superseded.
- `crosslinks.parent_blueprint` graph edge in `verify-flow` — preserved.
- `linked_symbols` semantics (ADR-010) — unchanged.

## References

- `docs/adr/015-task-tracking-at-orchestrator.md` — full text
- ADR 008 — storage-engine scope
- ADR 009 — orchestrator pattern
- ADR 014 — partially superseded (item 1 only)
- `docs/MSP_RELATIONSHIP.md` § task tracking — the contract
