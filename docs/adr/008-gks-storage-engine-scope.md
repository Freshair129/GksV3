# ADR 008 — GKS as storage engine; Memory OS layer above (MSP-shaped contract)

- **Status:** accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Context tag:** scope, msp, memory-os, layering, governance

## Context

GKS v3.5 shipped four storage layers (atomic / vector / episodic /
obsidian), bi-temporal versioning, multi-tenancy, MCP / CLI surfaces,
and observability. Throughout the build a recurring question kept
returning to the surface:

> *"Is this in scope for GKS? Or does it belong to MSP / Memory OS?"*

Specific cases that surfaced the question:

1. Should GKS validate **frontmatter schema**, **ID uniqueness**,
   **wikilink resolution**, and **forbidden fields** at write time?
2. Should GKS implement the **Session → Core → Sphere consolidation
   cascade** modelled on EVA's MSP-v9.1?
3. Should GKS absorb **AST / call-graph** capabilities (cf.
   GitNexus) so it can answer code-structure questions directly?
4. Should GKS bundle the **`msp:propose / review / promote / validate /
   index` CLI** + **pre-commit hook** that EVA uses?
5. Should GKS embed the **affect / RI / RMS** model when hosting EVA's
   memory?

Each request was individually sensible. Cumulatively they would have
turned GKS into a "do everything for EVA" mega-package — coupled to
EVA's lifecycle, hard to use in non-EVA projects, and impossible to
maintain without taking on EVA's parser/affect/workflow specialties.

The complication: the EVA project itself uses **"MSP" to mean at least
four different things** — a meta-framework spec
(`FRAMEWORK_MASTER_SPEC.md`), a thin Python wrapper around RMS, a
heavyweight Python `MSP-v9.1` Memory OS class, and a write-gateway /
validator pipeline. We can't pair "with MSP" without saying which one.

## Decision

**GKS is a storage engine.** It owns persistence, indexing, and
queryability. It deliberately does not implement Memory OS, workflow,
code intelligence, or domain-specific cognitive concepts.

The repo is **purposely Memory-OS-agnostic** — it doesn't depend on EVA
or any particular MSP — but it *is* designed to receive an **MSP-shaped
layer** above. The choices that bake this in are intentional, not
incidental:

1. **`gks/` is write-protected at the API level.**
   `InboundQueue.constructor` refuses any inbound directory inside
   `gksRoot`. There is no public API that writes a candidate atom
   except `proposeInbound()`. Direct file writes outside that path are
   the caller's responsibility.

2. **Default on-disk layout matches MSP convention.**
   `gksLayout(root)` resolves to
   `<root>/.brain/msp/projects/evaAI/{inbound,session,memory,audit}/`.
   This is the single source of truth used by the CLI, MCP server, and
   `MemoryStore` defaults.

3. **The contract surface stays narrow.**
   What GKS guarantees to a Memory OS layer:
   - `proposeInbound()` as the sole candidate-write path
   - `ATOMIC_ID_PATTERN` (TYPE--SLUG format check)
   - phase range 0–5
   - `applyNamespace()` stamping every write
   - bi-temporal versioning on retain
   - append-only `AuditLog` for traceability

   What GKS *defers* to the Memory OS layer:
   - schema validation against contract files
   - graph integrity (wikilink resolution, ID uniqueness, forbidden fields)
   - promote workflow (inbound → `gks/`)
   - process-artifact ID conventions (`MSP-IMP-`, `MSP-TSK-`, `MSP-WKT-`)
   - CLI commands + pre-commit hook
   - consolidation timing, RI / importance filtering, sandbox semantics
   - affect / emotion / RMS scoring

The boundary is captured in [`SCOPE.md`](../../SCOPE.md). The
relationship-with-MSP rationale is captured in
[`docs/MSP_RELATIONSHIP.md`](../MSP_RELATIONSHIP.md). A reference
implementation showing how a Memory OS plugs in lives at
[`examples/memory-os-architecture/`](../../examples/memory-os-architecture/).

## Consequences

**Positive**

- **Reusable across projects.** GKS works as the storage backend for
  EVA's MSP, for a custom thin gatekeeper, or for an agent that doesn't
  need a Memory OS at all.
- **Stable contract.** Memory OS implementers have a small, explicit
  surface to target instead of fighting GKS internals.
- **Maintainability.** Schema rules, parser specialties, and workflow
  conventions evolve on their own cycles outside this repo.
- **Scope creep has a clear answer.** A 5-question decision rule in
  `SCOPE.md` tells contributors when to push back: "if it's about
  *timing*, *policy*, *parsing*, or *process*, it's not GKS."
- **Forgetting the contract is now hard.** Cross-references from
  `inbound.ts`, `gksLayout()`, `SCOPE.md`, and the README all point at
  `MSP_RELATIONSHIP.md`.

**Negative**

- **No "out of the box" production use.** A team adopting GKS without
  a Memory OS gets only basic validation (ID format, phase range,
  namespace stamping, audit log). Wikilink integrity, schema
  enforcement, ID uniqueness, and the promote workflow have to be
  built or borrowed.
- **Not the EVA monorepo experience.** EVA developers used to
  `npm run msp:propose / promote` from one place; with this split they
  install/maintain the gatekeeper layer separately. We accept the
  extra wiring in exchange for the layer separation.
- **"Memory OS" is a load-bearing concept that lives outside the
  repo.** Without `MSP_RELATIONSHIP.md` the design intent of
  write-protected `gks/` + `.brain/msp/...` defaults looks arbitrary.
  We mitigate with explicit doc + source-comment cross-links, but the
  documentation discipline has to hold.

## Alternatives considered

1. **Absorb MSP-gatekeeper validators into GKS** — wikilink resolution,
   ID uniqueness, schema check, forbidden fields. *Rejected:* mixes
   storage correctness with consumer-specific schema rules; would make
   GKS depend on `atomic_contract.yaml`, an EVA file.

2. **Absorb MSP-v9.1 Memory OS** (Session → Core → Sphere cascade,
   RI levels, RMS plugin point). *Rejected:* couples GKS to EVA's
   cognitive paradigm; would force every consumer to inherit the 8→1
   cascade. The reference implementation under
   `examples/memory-os-architecture/` shows this is a clean separate
   layer.

3. **Multi-package monorepo** (`gks-core` + `gks-mcp` + `gks-cli` +
   `gks-msp-tools`). *Deferred.* Right answer if MSP-tooling demand
   from non-EVA projects materialises; today there is exactly one
   consumer (EVA), and the single-package layout is simpler. Revisit
   when a second user shows up.

4. **Polyrepo split.** *Deferred* for the same reason as (3); also
   adds CI / release-coordination overhead we don't have headcount for.

## References

- `SCOPE.md` — full in/out scope of GKS
- `docs/MSP_RELATIONSHIP.md` — the GKS ↔ MSP contract narrative
- `examples/memory-os-architecture/` — Python reference Memory OS
- `src/memory/inbound.ts` — write-protect enforcement (constructor)
- `src/memory/index.ts` — `gksLayout()` MSP-shaped path defaults
- `src/memory/atomic-id.ts` — `ATOMIC_ID_PATTERN`, the only ID rule
  GKS enforces
- ADR 003 (Pluggable backends) — the same "minimum viable contract"
  philosophy applied at the storage layer
- ADR 004 (Namespace as first-class) — the multi-tenant primitive
  Memory OS layers rely on
