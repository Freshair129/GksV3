# ADR 015 — Task tracking belongs to the orchestrator, not GKS

- **Status:** accepted
- **Date:** 2026-04-28
- **Deciders:** core
- **Context tag:** scope, taxonomy, lifecycle, msp, supersedes
- **Supersedes:** [ADR 014](./014-doc-to-code-enforcement.md) item 1
  (the `TASK--` prefix as a first-class atom)

## Context

ADR-014 item 1 added `TASK--` to the recognised atomic taxonomy and
created `gks/task/` as its home, mirroring master-spec §6.2's P4
microtask phase. The justification was "light-tier governance — tasks
churn fast, are leaf nodes." The reasoning was sound for **governance**
but wrong for **lifecycle**.

ADR-008 places GKS as a storage engine for **durable knowledge** —
atoms with settling time. ADRs are set-once. CONCEPTs harden into
specs. BLUEPRINTs are revised but persist. AUDITs are terminal proof
of compliance. Even `HOTFIX--` (ADR-014 item 4), despite its
short-lived 48-hour gate, leaves a durable audit-trail atom that
remains valuable indefinitely.

Tasks are different in kind:

- **Status churns hourly** — assigned, in-progress, blocked, done
- **Comments accumulate** — review chatter, blocker notes, hand-offs
- **Subtasks decompose recursively** — `imp > Task > subtask > microtask`
- **Once shipped, the task itself has zero retrieval value** —
  the only durable artefact is the `AUDIT--` it produced

Six months into a production project, `gks/task/` would contain
hundreds of completed tasks polluting the SSOT. Readers asking
"what does the system do" would wade through dead execution state
to find the durable decisions. The light-tier patch from ADR-012
addressed *governance friction* but not the underlying *lifecycle
mismatch*.

## Decision

**Remove `TASK--` from the recognised atomic taxonomy.** Task tracking
is **execution state**, owned by the orchestrator (MSP / evaAI / a CI
bot / Linear / whatever sits above GKS per ADR-009).

What stays in GKS:

- `BLUEPRINT--` continues to declare the **shape** of work — the file
  paths under `geography`, the high-level acceptance criteria, the
  architectural pattern. This is durable knowledge: "we plan to build
  X with Y components."
- `AUDIT--` continues to record **what completed** — terminal proof
  of which acceptance criteria passed, which performance numbers were
  measured, which residual risks remain. Durable knowledge: "X was
  built, here's how we know."
- `crosslinks.parent_blueprint` remains a recognised key on **any**
  atom that genuinely belongs under a blueprint (e.g. a future
  `EXAMPLE--` or domain-specific durable child). The chain walker in
  ADR-014 item 3 keeps walking it.

What moves out of GKS to the orchestrator layer:

- Live task / subtask / microtask trees (`T*.task.yaml` files)
- Status (assigned / in-progress / blocked / done)
- Per-task assignee and review history
- Per-microtask agent prompts and output traces
- Comments / discussion / blocker chatter

Concrete homes for execution state (the orchestrator picks):

| Home | When to use |
|---|---|
| `.brain/<ns>/tasks/` | Self-hosted (no separate orchestrator). Ephemeral, gitignored or thin-committed. |
| `msp/projects/<id>/tasks/` | A real MSP layer is in play. Lives in the MSP repo / namespace, not in `gks/`. |
| External tracker (Linear/Jira/Asana) | The org standardises elsewhere. `BLUEPRINT--` may carry a tracker URL in `meta`. |

GKS exposes the **integration points**:

- `BLUEPRINT.geography` — file paths the work will touch (durable shape)
- `AUDIT--` — outcome record at the end (durable proof)
- `crosslinks.resolves` — backfill atoms close the loop on `HOTFIX--`
  the same way audits close it on planned work

The orchestrator translates between live task state and these durable
edges (e.g. when a task closes, the orchestrator drafts an `AUDIT--`
candidate via `propose-inbound`).

## Consequences

**Positive**

- **Lifecycle stays clean.** Atoms remain durable; SSOT doesn't
  accumulate completed-task corpses. Six-month-old `gks/` trees stay
  readable.
- **Boundary stays honest.** ADR-008 said "no workflow gates / no
  process layer." TASK-- with churning status was a covert process
  layer in atom clothing.
- **Multi-tracker portability.** Teams using Linear, Jira, Asana, or
  pure file-based microtasks all integrate at the same seam — they
  feed `BLUEPRINT.geography` in and consume `AUDIT--` out.
- **Smaller surface for new contributors.** One fewer prefix to
  understand; the boundary "atom = durable" stays clear.

**Negative**

- **Documentation churn.** ADR-014, KNOWLEDGE-TYPES, the WORKFLOW
  doc, and atom templates all need to be updated. The `gks new-feature`
  scaffolder's `--task=` option needs to be replaced by a
  `--task-tracker=` flag that drops microtasks **outside** `gks/`.
- **Master-spec wording vs reality.** The spec mentions
  `T*.task.yaml`; this ADR makes those files live in
  `.brain/<ns>/tasks/` (or equivalent), not as recognised atoms.
  Documented as the integration mapping in `MSP_RELATIONSHIP.md`.

## What this ADR does NOT change

- ADR-008 storage scope — this ADR *enforces* it more strictly than
  before.
- ADR-009 orchestrator pattern — task tracking is exactly the kind of
  process timing ADR-009 places outside GKS.
- ADR-010 reverse citation lookup — `linked_symbols` still cite code
  paths from `BLUEPRINT--` and `AUDIT--`, which are durable.
- ADR-014 items 2, 3, 4, 5, 6 — `status` alias, `verify-flow`,
  `HOTFIX--`, `new-feature`, `validate --links` are all unchanged.
  Only item 1 is superseded.
- The `crosslinks.parent_blueprint` graph edge in `verify-flow` —
  preserved as a generic key any atom may use.

## Migration

`TASK--` is brand-new (added in 3.5.5, no atoms in production). The
removal is sweeping but safe:

- `AtomicType` union: drop `'task'`.
- `gks/task/`: empty folder, delete.
- `examples/atom-templates/TASK.md`: delete.
- `docs/KNOWLEDGE-TYPES.md`: remove the `TASK--` entry; replace with
  a one-paragraph "task tracking lives in the orchestrator" pointer.
- `src/scaffold/new-feature.ts`: drop `tasks?:` and the `TASK--`
  scaffolder loop. Add `--task-tracker=msp|local|external` that, when
  set to `local`, drops `T<n>_<slug>.task.yaml` skeletons in
  `<root>/.brain/<ns>/tasks/<slug>/` (outside `gks/`).
- `docs/WORKFLOW.md`: P4 step rewords from "TASK-- atom" to "tracker
  entry" with three concrete options.
- `docs/MSP_RELATIONSHIP.md`: new section explaining the task-state
  contract (orchestrator owns it; GKS exposes BLUEPRINT.geography in,
  AUDIT-- out).
- `gks/adr/ADR--DOC-TO-CODE-ENFORCEMENT.md` (atom mirror): add
  `crosslinks.superseded_by: [ADR--DEVLOG-AT-ORCHESTRATOR]` on the
  TASK-- statement; add a new atom mirror for this ADR.

No data migration needed because `gks/task/` was never populated
outside the dogfood tree.

## Alternatives considered

1. **Keep `TASK--` as light-tier with a sweep policy.** *Rejected.*
   Sweep policies (delete after N days closed) introduce process
   timing into GKS — exactly what ADR-008 says belongs in MSP.

2. **Move `TASK--` into the IssueStore / HotfixStore pattern** —
   light-tier light-storage, file-backed, but outside the atomic
   index. *Rejected.* That's still GKS owning task state; the
   architecture argument applies equally to the storage as to the
   index.

3. **Keep the prefix; restrict to "completed-task summary" atoms only.**
   *Rejected.* Those summaries already have a name — they are
   `AUDIT--`. Two prefixes for the same notion is the SSOT split this
   project exists to prevent.

4. **Defer until a real project hits the bloat problem.** *Rejected.*
   Dogfood feedback (`devlog hierarchy belongs to MSP`) surfaced the
   problem before any production project shipped. Removing now is one
   PR; removing after six months of accumulated tasks is a migration.

## References

- ADR 008 — storage-engine scope (this ADR strengthens enforcement)
- ADR 009 — orchestrator pattern (task tracking is its territory)
- ADR 012 — extended taxonomy (TASK-- entry removed in this ADR)
- ADR 014 — doc-to-code enforcement (item 1 superseded; items 2-6
  unaffected)
- `docs/MSP_RELATIONSHIP.md` — updated in this PR with the task-state
  contract
