# Pairing GKS with MSP

> **Why this doc exists.** GKS was deliberately built without MSP as a hard
> dependency — to keep it usable with any Memory OS layer above. But MSP
> *is* the primary Memory OS this repo was designed against, and that
> design intent isn't visible from the code alone. Without this doc, new
> contributors (and future us) see the inbound queue, the
> `.brain/msp/...` defaults, the write-protected `gks/` and wonder *why*.
> The "why" is MSP. This doc records the relationship without coupling
> the two.

## Which MSP?

The name "MSP" is overloaded. Two distinct projects share it, and the
contract this doc describes is broad enough to cover both:

| | **MSP-v9.1** (EVA's) | **MSP-this-repo** ([`Freshair129/msp`](https://github.com/Freshair129/msp)) |
|---|---|---|
| Language | Python | TypeScript |
| Focus | Biological consolidation Memory OS — RI levels, RMS affect, Session→Core→Sphere cascade | Passport-orchestrator — agent-agnostic, plugs into Claude Code / Gemini CLI / Antigravity / EVA / Hermes / openclaw |
| Process IDs | `MSP-IMP-` / `-TSK-` / `-ACT-` / `-WKT-` (EVA's `FRAMEWORK_MASTER_SPEC.md`) | None — agent-neutral |
| Workflow today | EVA's six-phase cascade | `msp_candidate` MCP tool → `.brain/msp/projects/<id>/candidates/` → human PR → `gks/` |

When this doc says "MSP-this-repo" it means the TypeScript orchestrator;
when it says "MSP-v9.1" or "EVA's MSP" it means the Python Memory OS.
"MSP" without qualification is the broader pattern both implement.

## TL;DR

- **GKS** = storage engine (this repo). Owns: atomic / vector / episodic
  / obsidian, audit log, namespace, MCP server, CLI.
- **MSP** = Memory OS gatekeeper (lives in your project, e.g. EVA, or
  in [`Freshair129/msp`](https://github.com/Freshair129/msp)). Owns:
  schema validation, ID-uniqueness, wikilink resolution, candidate→PR
  promote workflow.
- **Contract**: GKS exposes `proposeInbound()` (programmatic) and a
  `candidates/` directory convention (review-flow). MSP validates +
  produces a PR; `gks/` is write-protected.

## Why GKS doesn't ship MSP itself

1. **Scope** — workflow / governance lives outside the storage engine
   (see [`SCOPE.md`](../SCOPE.md) "Out of scope").
2. **Pluggability** — many Memory OS shapes are valid: EVA's MSP-v9.1,
   FRAMEWORK_MASTER_SPEC's gatekeeper, or a custom thin one. GKS shouldn't
   force one.
3. **Versioning** — MSP evolves with your project lifecycle; coupling
   would mean every MSP change forces a GKS release.

## Design intent baked into GKS

These choices are **not** accidental — they exist *specifically* to leave
room for an MSP-shaped layer above:

| GKS code | What it enforces | Why MSP needs it |
|---|---|---|
| `src/memory/inbound.ts` constructor | Refuses inbound dir inside `gksRoot` | `gks/` stays write-protected; inbound is the only entry |
| `MemoryStore.proposeInbound()` (`src/memory/index.ts`) | Single write API for candidate atoms | MSP can't be bypassed |
| `src/memory/atomic-id.ts` `ATOMIC_ID_PATTERN` | TYPE--SLUG format check | MSP's ID conventions plug in here |
| `src/memory/index.ts` `gksLayout()` | Default paths under `.brain/msp/projects/<path>/{inbound,session,memory,audit}/` | Defaults match MSP layout exactly. **Note**: `inbound/` is still in the default layout for back-compat with non-MSP consumers; MSP-this-repo now writes to `candidates/` instead (see below). |
| `src/memory/inbound.ts` `renderArtifactMarkdown` | Stamps namespace + frontmatter | MSP reviewers see provenance |
| `src/memory/audit.ts` (append-only JSONL) | Every write op is logged | MSP relies on this for traceability |

If you ever feel like changing one of these "for convenience", check this
table first — you're probably about to break the MSP contract.

## What MSP brings on top

MSP is the gatekeeper between agents and the canonical SSOT (`gks/`).
What MSP owns (and GKS does *not*):

- **Validation pipeline**
  - Frontmatter schema (`atomic_contract.yaml`)
  - ID uniqueness (e.g. ADR number = max+1)
  - Wikilink resolution (`[[X]]` must resolve to a real atom)
  - Forbidden fields (`commit_hash`, `reviewer_approved_at`, …)
- **Workflow** (MSP-this-repo, current — completed
  `BLUEPRINT--INBOUND-TO-CANDIDATES-MIGRATION` in Phase 3, see
  `Freshair129/msp@7eff62b`)
  - Agent → `msp_candidate` MCP tool → `.brain/msp/projects/<id>/candidates/`
    → human review (PR) → `gks/`
  - The earlier `/submit-memory` slash command + `msp_propose` MCP tool
    + `scripts/msp/propose.mjs` are removed; the inbound queue is gone.
- **CLI commands** (MSP-this-repo, current)
  - `npm run msp:validate`, `msp:check-links`, `msp:run-task`,
    `msp:master`, `msp:graph`, `msp:hotfix:*`
  - `msp:propose` / `:review` / `:promote` are removed.
- **Pre-commit hook**
  - Blocks commits if MSP validation fails
- **Contract files**
  - `.brain/msp/LLM_Contract/atomic_contract.yaml` (atomic schema)
  - `.brain/msp/LLM_Contract/codegen_microtask_contract.yaml` (Phase 3.5)

None of this lives in GKS.

### What MSP-this-repo owns (agent-agnostic)

The TypeScript orchestrator at `Freshair129/msp` formally declared
itself agent-agnostic and removed EVA's `CORE_FRAMEWORK_MASTER_SPEC.md`
(see [Freshair129/msp#65](https://github.com/Freshair129/msp/pull/65)).
Its public surface is now:

| Concern | Owner |
|---|---|
| Candidate atom intake (`msp_candidate` MCP tool) | MSP-this-repo |
| `candidates/` → PR diffing + reviewer workflow | MSP-this-repo |
| Schema / wikilink / ID-uniqueness validation | MSP-this-repo |
| Pre-commit hook orchestration | MSP-this-repo |
| Hotfix lifecycle CLI (`msp:hotfix:*`) | MSP-this-repo |
| RI / RMS / Session→Core→Sphere cascade | **EVA's MSP-v9.1** (not MSP-this-repo) |
| `MSP-IMP-` / `MSP-TSK-` / `MSP-ACT-` / `MSP-WKT-` IDs | **EVA's `FRAMEWORK_MASTER_SPEC.md`** (not MSP-this-repo) |

If you're integrating MSP-this-repo into a non-EVA agent (Claude Code,
Gemini CLI, Antigravity, Hermes, openclaw, …) the right-hand rows
above don't apply — they're EVA-specific.

### EVA-specific process artifacts

EVA's MSP-v9.1 uses these IDs to mark its six-phase cascade:

- `MSP-IMP-` (P3 plan) → `MSP-TSK-` (P4 task) → `MSP-ACT-` (P5 action)
  → `MSP-WKT-` (P6 walkthrough), all carrying `sessionId` for audit
  traceability.

These come from EVA's `FRAMEWORK_MASTER_SPEC.md` (referenced in
[`SCOPE.md`](../SCOPE.md)). They are **not** part of the GKS↔MSP
contract — a non-EVA Memory OS doesn't need them. If you're wiring
GKS to EVA specifically, treat the above as the authoritative ID
list; otherwise ignore.

## Other Memory OS layers that fit

Anything that honours the contract above works. References:

- **EVA's MSP-v9.1** (Python) — biological consolidation Memory OS, adds
  Session→Core→Sphere cascade + RI levels + RMS affect.
- **[`examples/memory-os-architecture/`](../examples/memory-os-architecture/)** —
  Python reference impl that layers a paradigm-agnostic Memory OS on
  GKS, with EVA-specific extensions in a separate plugin module.
- **Custom thin gatekeeper** — minimum viable: validate before calling
  `proposeInbound()`, implement your own promote step, append to
  `gks/00_index/atomic_index.jsonl`. Doesn't need RMS, cascades, or
  affect — just the contract below.

## Compatibility checklist (for Memory OS implementers)

If you're building a Memory OS for GKS, verify:

- [ ] Reads happen via `gks_recall` / `gks_lookup` (no special contract)
- [ ] Writes go *only* through `proposeInbound()` — never directly to `gks/`
- [ ] Frontmatter validated against your schema **before** calling
      `proposeInbound` — GKS only checks ID format + phase range
- [ ] Promote step moves `inbound/<id>.<rev>.md` →
      `gks/<phase>/<type>/<slug>.md`
- [ ] Promote step appends/updates `gks/00_index/atomic_index.jsonl`
- [ ] Your process-artifact IDs (`MSP-IMP-` / `-TSK-` / `-WKT-`) carry
      `sessionId` for traceability — but stored wherever you choose,
      *not* in `gks/`
- [ ] Wikilink resolution + ID uniqueness + forbidden fields enforced
      *by you* (GKS won't catch these)

That's it. GKS won't help you enforce these — they're your responsibility
as the Memory OS implementer.

## Coexisting with peer subsystems (e.g. GitNexus)

GKS isn't the only specialised subsystem your Memory OS will want to
talk to. Code-intelligence engines (e.g. [GitNexus](https://github.com/nxpatterns/gitnexus)),
external KBs, observability stores, vector-search-as-a-service — these
are *peers* of GKS, not layers above or below it.

The pattern: **MSP orchestrates; GKS does not proxy.** GKS has no
knowledge of GitNexus (no import, no MCP-tool-that-fans-out, no
optional dependency). When MSP needs a correlated answer it fans out
in parallel and merges:

```
┌──────────────────────────────────┐
│ Agent                             │
└────────────────┬─────────────────┘
                 │
                 ▼
┌──────────────────────────────────┐
│ MSP — orchestrator                │
│  • routes per query type          │
│  • parallel fan-out + merge       │
└──┬──────────────────────┬────────┘
   │                      │
   ▼                      ▼
┌────────────┐    ┌──────────────┐
│  GKS       │    │  GitNexus    │
│  memory    │    │  code AST    │
└────────────┘    └──────────────┘
   (peers — no edge between them)
```

Worked example — agent asks *"What does ADR-007 say, and what would
break if I refactor the function it governs?"*:

```
agent → MSP
         ├── GKS.lookup("ADR-007")             ← parallel
         └── GitNexus.impact("formatStep")     ← parallel
        merged response back to agent
```

The decision and full reasoning live in
[ADR-009](./adr/009-msp-as-orchestrator.md). Importantly: caching
GitNexus call-edges into GKS's `GraphBackend` for fast reads is
*allowed* and is **not** a violation — that's denormalisation owned by
MSP, not a runtime dependency.

### Cross-referencing code from atomic notes

Atomic notes can carry a `linked_symbols` field naming the code symbols
they govern; MSP resolves those references against GitNexus when a
correlated answer is needed.

```ts
await retain(store, {
  content: 'Normalize spoofed [USER]/[AGENT] tags before LLM consolidation.',
  proposeInbound: true,
  inboundType: 'adr',
  inboundPhase: 2,
  linkedSymbols: [
    { file: 'src/memory/consolidator-llm.ts', fn: 'formatStep' },
    { file: 'src/memory/consolidator-llm.ts', fn: 'validateExtractorOutput', line: 320 },
  ],
})
```

Renders into the inbound markdown as:

```yaml
---
proposed_id: ADR--PARSE-TRACE-NORM
phase: 2
type: adr
status: raw
linked_symbols:
  - {"file":"src/memory/consolidator-llm.ts","fn":"formatStep"}
  - {"file":"src/memory/consolidator-llm.ts","fn":"validateExtractorOutput","line":320}
---
```

GKS only stores + serialises these — it does not parse code, resolve
symbols, or check that they exist. Resolution is the orchestrator's
job (call GitNexus, dereference, merge with the atom's text). The
field is also exposed via the `gks_propose_inbound` MCP tool's
`linked_symbols` input.

For the MCP-config recipe that runs both servers side-by-side, see
the README section [Pairing with a code-structure layer](../README.md#pairing-with-a-code-structure-layer-eg-gitnexus).

## Task tracking — orchestrator territory (ADR-015)

Live task / subtask / microtask state is **execution state**, not
durable knowledge. It belongs to the orchestrator, not GKS.

The boundary:

| Concern | Layer | Atom / file |
|---|---|---|
| Why we plan to do X | GKS (durable) | `CONCEPT--` |
| What we decided | GKS (durable) | `ADR--` |
| What user-facing thing X does | GKS (durable) | `FEAT--` |
| Plan for which files X touches | GKS (durable) | `BLUEPRINT--` (`geography`) |
| Live task status (open/in-progress/done) | **MSP / orchestrator** | task tracker |
| Per-microtask agent prompt | **MSP / orchestrator** | `T<n>_<slug>.task.yaml` |
| Subtask decomposition | **MSP / orchestrator** | tracker tree |
| Reviewer chatter / comments | **MSP / orchestrator** | tracker comments |
| Verification outcome | GKS (durable) | `AUDIT--` |

Atoms have **settling time** — they're meant to be cited unchanged a
year later. Tasks churn hourly. Mixing the two would pollute the SSOT
with hundreds of completed-task corpses inside six months.

### Concrete handoff between layers

```
GKS                                    MSP / orchestrator
─────                                  ──────────────────

BLUEPRINT--FOO  ──── geography ────►   create tracker entries per file
                     (file paths)      assign agents, run microtasks

                                       (live status churns here —
                                        not visible to GKS)

                                       tracker entry closes
                                       │
                  ◄── propose_inbound ─┘
AUDIT--FOO  ◄── promote                  with outcome + numbers
   │
   └─ crosslinks.references: [FEAT--FOO, BLUEPRINT--FOO]
```

### Where microtasks live (pick one)

- **`.brain/<ns>/tasks/<slug>/T<n>_<name>.task.yaml`** — self-hosted,
  no separate orchestrator. `gks new-feature --task-tracker=local`
  drops skeletons here.
- **`msp/projects/<id>/tasks/`** — a real MSP layer is in play. The
  scaffolder emits guidance lines pointing at the MSP API; MSP owns
  the actual writes.
- **External tracker (Linear / Jira / Asana)** — `BLUEPRINT--` may
  carry a tracker URL in its frontmatter `meta`. Tasks live in the
  external system; GKS only sees them indirectly via `AUDIT--`.

In every case GKS treats microtasks as **opaque** — it does not index
them, walk them in `verify-flow`, or try to enforce their integrity.
That's deliberate: the lifecycles are different, the storage shapes
should be too.

## Read more

- [`../SCOPE.md`](../SCOPE.md) — full in/out scope of GKS itself
- [`./adr/008-gks-storage-engine-scope.md`](./adr/008-gks-storage-engine-scope.md) — vertical layering decision (GKS vs Memory OS)
- [`./adr/009-msp-as-orchestrator.md`](./adr/009-msp-as-orchestrator.md) — horizontal layering decision (peer subsystems)
- [`./adr/015-task-tracking-at-orchestrator.md`](./adr/015-task-tracking-at-orchestrator.md) — why TASK-- left the atomic taxonomy
- [`../examples/memory-os-architecture/README.md`](../examples/memory-os-architecture/README.md)
  — reference Memory OS impl walkthrough
- EVA project's `FRAMEWORK_MASTER_SPEC.md` (external) — full MSP spec
