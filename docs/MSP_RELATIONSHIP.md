# Pairing GKS with MSP

> **Why this doc exists.** GKS was deliberately built without MSP as a hard
> dependency — to keep it usable with any Memory OS layer above. But MSP
> *is* the primary Memory OS this repo was designed against, and that
> design intent isn't visible from the code alone. Without this doc, new
> contributors (and future us) see the inbound queue, the
> `.brain/msp/...` defaults, the write-protected `gks/` and wonder *why*.
> The "why" is MSP. This doc records the relationship without coupling
> the two.

## TL;DR

- **GKS** = storage engine (this repo). Owns: atomic / vector / episodic
  / obsidian, audit log, namespace, MCP server, CLI.
- **MSP** = Memory OS gatekeeper (lives in your project, e.g. EVA).
  Owns: schema validation, ID-uniqueness, wikilink resolution, promote
  workflow, process-artifact IDs (`MSP-IMP-`, `MSP-TSK-`, …).
- **Contract**: GKS exposes `proposeInbound()` as the *only* write-path
  to candidate atoms; MSP validates + promotes; `gks/` is write-protected.

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
| `src/memory/index.ts` `gksLayout()` | Default paths under `.brain/msp/projects/<path>/{inbound,session,memory,audit}/` | Defaults match MSP layout exactly |
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
- **Workflow**
  - Agent → `/submit-memory` → inbound queue → human review → promote → `gks/`
- **Process artifacts**
  - `MSP-IMP-` (P3 plan) → `MSP-TSK-` (P4 task) → `MSP-ACT-` (P5 action)
    → `MSP-WKT-` (P6 walkthrough), all carrying `sessionId` for audit
    traceability
- **CLI commands**
  - `npm run msp:propose` / `review` / `promote` / `validate` / `index`
- **Pre-commit hook**
  - Blocks commits if MSP validation fails
- **Contract files**
  - `.brain/msp/LLM_Contract/atomic_contract.yaml` (atomic schema)
  - `.brain/msp/LLM_Contract/codegen_microtask_contract.yaml` (Phase 3.5)

None of this lives in GKS.

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

## Read more

- [`../SCOPE.md`](../SCOPE.md) — full in/out scope of GKS itself
- [`./adr/008-gks-storage-engine-scope.md`](./adr/008-gks-storage-engine-scope.md) — vertical layering decision (GKS vs Memory OS)
- [`./adr/009-msp-as-orchestrator.md`](./adr/009-msp-as-orchestrator.md) — horizontal layering decision (peer subsystems)
- [`../examples/memory-os-architecture/README.md`](../examples/memory-os-architecture/README.md)
  — reference Memory OS impl walkthrough
- EVA project's `FRAMEWORK_MASTER_SPEC.md` (external) — full MSP spec
