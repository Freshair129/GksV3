# CLAUDE.md — GKS v3 Agent Guide

Genesis Knowledge System — a **storage engine** for agent memory.
Four cooperating layers (Atomic, Vector, Episodic, Obsidian) behind
three verbs (`retain` / `recall` / `reflect`), with multi-tenancy,
bi-temporal versioning, and pluggable backends.

---

## Quick commands

```sh
npm run typecheck          # tsc --noEmit (run before every commit)
npm test                   # vitest run — 321 tests
npm run build              # tsc -p tsconfig.build.json
npm run quickstart         # end-to-end demo

# GKS CLI (dev, no build needed)
npx tsx bin/gks.ts <cmd> --root=.
```

---

## Agent Rule (§6.3 — run before every commit)

```sh
gks validate --links --root=.              # check all crosslink integrity
gks verify-flow <FEAT--ID> --root=.        # walk doc→code chain, exit-1 if broken
```

Both must exit 0. If `verify-flow` fails, fix the broken link in
`gks/<type>/<id>.md` before committing.

---

## Doc-to-code loop (P1→P6)

| Phase | Artifact | CLI |
|-------|----------|-----|
| P1 | `CONCEPT--` | `gks propose-inbound` / `gks new-feature` |
| P2 | `ADR--` | `gks propose-inbound` |
| P3 | `BLUEPRINT--` | `gks propose-inbound` |
| P4 | `FEAT--` | auto-scaffolded by `gks new-feature` |
| P5 | source code | normal dev |
| P6 | `AUDIT--` | `gks propose-inbound` after code review |

Full daily workflow: [`docs/WORKFLOW.md`](./docs/WORKFLOW.md)

### Hotfix escape hatch

When a fix must ship before P1–P3 atoms exist:

```sh
gks hotfix open <sha> --reason="<why>" --root=.   # creates HOTFIX-- atom, valid_to = now+48h
gks hotfix list --root=.                           # show open hotfixes + countdown
gks hotfix close <sha> --root=.                    # mark resolved after backfill
```

After `valid_to` the pre-commit hook blocks further commits on the
affected files until CONCEPT/ADR/BLUEPRINT are written and stable.

---

## Branch convention

- Develop on `claude/build-gks-v3-<suffix>` — **never push directly to main**
- `git push -u origin <branch>` then open a draft PR
- After all tests green, request merge

---

## Atom taxonomy (quick-ref)

| Prefix | Meaning | Tier |
|--------|---------|------|
| `CONCEPT--` | Idea / background knowledge | strict (inbound queue) |
| `ADR--` | Architecture decision | strict |
| `BLUEPRINT--` | Implementation plan | strict |
| `FEAT--` | User-facing feature | strict |
| `AUDIT--` | Post-implementation review | strict |
| `FR--` | Functional requirement | strict |
| `NFR--` | Non-functional requirement | strict |
| `ISSUE--` | Bug / problem report | light (direct write) |
| `HOTFIX--` | Emergency bypass atom | light |
| `INC--` | Incident post-mortem | light |
| `GUARDRAIL--` | Hard constraint | strict |
| `RISK--` | Risk register entry | strict |
| `RUNBOOK--` | Operational playbook | strict |
| `SLO--` | Service-level objective | strict |
| `SKILL--` | Agent capability | strict |
| `ALGO--` | Algorithm spec | strict |
| `ENTITY--` | Data-model entity | strict |
| `FLOW--` | Interaction / sequence flow | strict |
| `PROTOCOL--` | Communication protocol | strict |

> `TASK--` is **deprecated** (ADR-015). Live task state belongs to the
> orchestrator (MSP / evaAI). Use `--task-tracker=local|msp|external`
> with `gks new-feature` instead.

Full taxonomy: [`docs/KNOWLEDGE-TYPES.md`](./docs/KNOWLEDGE-TYPES.md)

---

## Document index

### Root-level

| File | Purpose |
|------|---------|
| [`README.md`](./README.md) | Project overview, install, quickstart, backends table |
| [`SCOPE.md`](./SCOPE.md) | What GKS is / is not — read before proposing features |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev setup, hook install, PR flow, hotfix protocol |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release history |

### docs/

| File | Purpose |
|------|---------|
| [`docs/WORKFLOW.md`](./docs/WORKFLOW.md) | **Daily P1→P6 loop** — every CLI command at each step |
| [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) | Adopting GKS in an existing project (7 phases + full-migration) |
| [`docs/TECHNICAL-OVERVIEW.md`](./docs/TECHNICAL-OVERVIEW.md) | Standalone technical reference — architecture, API, all layers |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Layer model + sequence diagrams |
| [`docs/KNOWLEDGE-TYPES.md`](./docs/KNOWLEDGE-TYPES.md) | Full 30+ atom-prefix reference |
| [`docs/MSP_RELATIONSHIP.md`](./docs/MSP_RELATIONSHIP.md) | GKS ↔ MSP contract; GitNexus peer pattern |
| [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) | OTel setup, span names, metrics, dashboards |
| [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md) | Schema versioning policy |
| [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) | LoCoMo / LongMemEval / BEAM runners |
| [`docs/ULTRAPLAN.md`](./docs/ULTRAPLAN.md) | Multi-phase roadmap |

### docs/adr/

| File | Decision |
|------|---------|
| [`001`](./docs/adr/001-file-based-vector-store.md) | File-based JSONL vector store as default |
| [`002`](./docs/adr/002-bi-temporal-conflict-resolution.md) | Bi-temporal conflict resolution |
| [`003`](./docs/adr/003-pluggable-backends.md) | Pluggable backends |
| [`004`](./docs/adr/004-namespace-as-first-class.md) | Namespace as first-class concept |
| [`005`](./docs/adr/005-cut-falkordb.md) | Cut FalkorDB dependency |
| [`006`](./docs/adr/006-otel-noop-default.md) | OTel noop default |
| [`007`](./docs/adr/007-mcp-server-stdio-only.md) | MCP server stdio-only |
| [`008`](./docs/adr/008-gks-storage-engine-scope.md) | GKS as storage engine (not Memory OS) |
| [`009`](./docs/adr/009-msp-as-orchestrator.md) | MSP as orchestrator; GitNexus as peer |
| [`010`](./docs/adr/010-reverse-citation-lookup.md) | Reverse citation lookup (`lookupBySymbol`) |
| [`011`](./docs/adr/011-test-policy.md) | Test policy |
| [`012`](./docs/adr/012-extended-taxonomy.md) | Extended atom taxonomy (30+ prefixes) |
| [`013`](./docs/adr/013-flat-atom-layout.md) | Flat `gks/<type>/` layout (no phase prefix) |
| [`014`](./docs/adr/014-doc-to-code-enforcement.md) | Doc-to-code enforcement model (P1→P6, Agent Rule, Hotfix) |
| [`015`](./docs/adr/015-task-tracking-at-orchestrator.md) | TASK-- deprecated; task state at orchestrator |

### Source

| Path | Contents |
|------|---------|
| [`src/memory/index.ts`](./src/memory/index.ts) | Public API — `retain`, `recall`, `reflect`, `MemoryStore` |
| [`src/memory/types.ts`](./src/memory/types.ts) | Core types — `AtomicType`, `Namespace`, `normaliseStatus` |
| [`src/memory/gks.ts`](./src/memory/gks.ts) | `MemoryStore` class |
| [`src/memory/api.ts`](./src/memory/api.ts) | `retain` / `recall` / `reflect` implementations |
| [`src/memory/inbound.ts`](./src/memory/inbound.ts) | `InboundQueue` — propose / list / readById / **promote** |
| [`src/memory/verify-flow.ts`](./src/memory/verify-flow.ts) | `verifyFlow()` — walks crosslinks, returns broken edges |
| [`src/memory/validate-links.ts`](./src/memory/validate-links.ts) | `validateLinks()` — checks all crosslink integrity |
| [`src/memory/consolidator.ts`](./src/memory/consolidator.ts) | Heuristic consolidator |
| [`src/memory/consolidator-llm.ts`](./src/memory/consolidator-llm.ts) | Anthropic-backed LLM consolidator |
| [`src/memory/session.ts`](./src/memory/session.ts) | Session lifecycle (episodic layer) |
| [`src/memory/episodic.ts`](./src/memory/episodic.ts) | Episodic store |
| [`src/memory/vector/`](./src/memory/vector/) | JSONL / pgvector / HNSW backends |
| [`src/memory/graph/`](./src/memory/graph/) | In-memory / Pg graph backends |
| [`src/memory/audit.ts`](./src/memory/audit.ts) | Append-only audit log |
| [`src/hotfix/store.ts`](./src/hotfix/store.ts) | `HotfixStore` — open / list / listOverdue / close |
| [`src/hotfix/types.ts`](./src/hotfix/types.ts) | `Hotfix` interface, `HOTFIX_BACKFILL_MS`, `isOverdue` |
| [`src/issue/store.ts`](./src/issue/store.ts) | `IssueStore` — ISSUE-- lifecycle |
| [`src/issue/types.ts`](./src/issue/types.ts) | `Issue` interface and status types |
| [`src/scaffold/new-feature.ts`](./src/scaffold/new-feature.ts) | `scaffoldNewFeature()` — drops 4 inbound candidates |
| [`src/mcp-server/index.ts`](./src/mcp-server/index.ts) | MCP server — 13 tools exposed over stdio |
| [`src/lib/retry.ts`](./src/lib/retry.ts) | Exponential-backoff retry |
| [`src/lib/circuit-breaker.ts`](./src/lib/circuit-breaker.ts) | Circuit breaker |
| [`src/lib/telemetry.ts`](./src/lib/telemetry.ts) | OTel API helpers |
| [`src/lib/telemetry-setup.ts`](./src/lib/telemetry-setup.ts) | `setupTelemetry()` bootstrap |
| [`src/lib/cost-tracker.ts`](./src/lib/cost-tracker.ts) | Per-session token + USD tracking |
| [`src/lib/schema-version.ts`](./src/lib/schema-version.ts) | Manifest schema versioning |
| [`bin/gks.ts`](./bin/gks.ts) | CLI entry point |
| [`bin/gks-mcp-server.ts`](./bin/gks-mcp-server.ts) | MCP server entry point |

### Tests

| Path | What it covers |
|------|---------------|
| [`test/memory/`](./test/memory/) | Core retain / recall / reflect / inbound / promote |
| [`test/memory/inbound-promote.test.ts`](./test/memory/inbound-promote.test.ts) | `InboundQueue.list / readById / promote` contract |
| [`test/hotfix/`](./test/hotfix/) | `HotfixStore` open / list / overdue / close |
| [`test/issue/`](./test/issue/) | `IssueStore` lifecycle |
| [`test/mcp/`](./test/mcp/) | MCP server tools end-to-end (in-process transport) |
| [`test/cli/`](./test/cli/) | CLI commands via subprocess |
| [`test/scaffold/`](./test/scaffold/) | `scaffoldNewFeature` |
| [`test/lib/`](./test/lib/) | retry / circuit-breaker / cost-tracker / schema-version |
| [`test/integration/`](./test/integration/) | Multi-layer integration scenarios |

### Examples & templates

| Path | Purpose |
|------|---------|
| [`examples/quickstart.ts`](./examples/quickstart.ts) | End-to-end walkthrough (run with `npm run quickstart`) |
| [`examples/atom-templates/`](./examples/atom-templates/) | Canonical templates for every atom type |
| [`examples/full-flow/run-feature.sh`](./examples/full-flow/run-feature.sh) | Bash runner: propose → promote → verify-flow |
| [`examples/msp-task-tracker/`](./examples/msp-task-tracker/) | MSP-side task tracker wired to GKS inbound |
| [`examples/memory-os-architecture/`](./examples/memory-os-architecture/) | Python proof-of-concept Memory OS on top of GKS |
| [`examples/gitnexus-graph-cache/`](./examples/gitnexus-graph-cache/) | GitNexus → `GraphStore` denormalisation pattern |
| [`examples/drift-detection/`](./examples/drift-detection/) | Bidirectional doc/code drift detector |

### Repo's own atom tree (`gks/`)

```
gks/
  adr/      ADR--DOC-TO-CODE-ENFORCEMENT, ADR--EXTENDED-TAXONOMY,
            ADR--FLAT-ATOM-LAYOUT, ADR--REVERSE-CITATION-LOOKUP,
            ADR--TASK-TRACKING-AT-ORCHESTRATOR
  blueprint/ BLUEPRINT--ISSUE-CLI
  concept/  CONCEPT--MEMORY-STORE
  feat/     FEAT--ISSUE-TRACKER, FEAT--LOOKUP-BY-SYMBOL
  frame/    FRAME--FOUR-LAYERS
  00_index/ atomic_index.jsonl  ← rebuilt by `npm run msp:index`
```

Try: `npx tsx bin/gks.ts lookup ADR--FLAT-ATOM-LAYOUT --root=.`

---

## MCP tools (13 total)

| Tool | Purpose |
|------|---------|
| `gks_retain` | Store a document in memory |
| `gks_recall` | Semantic search across all layers |
| `gks_lookup` | Exact atomic-id lookup |
| `gks_lookup_by_symbol` | Find atoms citing a `file:fn` symbol |
| `gks_propose_inbound` | Write a candidate to the inbound queue |
| `gks_reflect` | Trigger consolidation |
| `gks_verify_flow` | Walk crosslinks from an atom; exit-1 on broken edges |
| `gks_validate_links` | Check all crosslink integrity in the tree |
| `gks_new_feature` | Scaffold CONCEPT/ADR/FEAT/BLUEPRINT into inbound |
| `gks_hotfix_open` | Open a HOTFIX-- atom (48 h backfill window) |
| `gks_hotfix_list` | List open / overdue hotfixes |
| `gks_hotfix_close` | Mark a hotfix resolved |
| `gks_recall_cross_namespace` | Admin: cross-tenant recall (gated) |
