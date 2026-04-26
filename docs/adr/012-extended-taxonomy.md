# ADR 012 — Extended atomic taxonomy + ISSUE-- as self-hosted tracker

- **Status:** accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Context tag:** taxonomy, governance, issue-tracking, scope

## Context

The atomic-knowledge taxonomy in `FRAMEWORK_MASTER_SPEC §4.1` was
designed implementation-first: it's strong on the build pipeline
(IDEA → CONCEPT → ADR/FEAT/ALGO/ENTITY → BLUEPRINT → microtask → code →
AUDIT) and weak on three orthogonal axes that any non-trivial agentic
project hits within the first month:

1. **Agent governance.** Skills, protocols, guardrails, policies, and
   agent personas have no canonical home. They get smeared across
   `ADR--`, `FRAME--`, `MOD--`, or — worse — encoded in code comments
   that auditors can't find.
2. **Requirements engineering.** `CONCEPT--REQ.md` lumps functional and
   non-functional requirements together; verification approaches differ
   sharply (unit tests vs load tests vs penetration tests), so lumping
   them costs traceability.
3. **Operations governance.** Incidents, problems, risks, runbooks, and
   SLOs are first-class concerns once the system is in production —
   none of them have a prefix in the existing taxonomy.

Additionally, projects routinely depend on external issue trackers
(Linear, Jira, GitHub Issues) for live operational tracking. Many
EVA-style deployments want **self-host** — every artefact lives in
`gks/` so the knowledge graph is complete and audit-traceable without
a second SaaS subscription.

These four gaps (governance, RE, ops, self-host issue tracking) are not
"nice to have for some projects." They are core capabilities of any
agentic memory system that ships to production.

## Decision

Extend the atomic taxonomy from **17** prefixes to roughly **30** core
prefixes organised into four named clusters, and elevate `ISSUE--` to
"first-class self-hosted issue tracker" with its own governance tier.

### Cluster 1 — Implementation Flow (existing, unchanged)

```
IDEA-- → CONCEPT-- → ADR-- · MOD-- · FEAT-- · ALGO-- · FLOW-- ·
ENTITY-- · API-- · ENDPOINT-- · ENTRYPOINT-- · PARAMS-- · FRAME-- →
BLUEPRINT-- → T* → src/ → AUDIT--
```

### Cluster 2 — Agent Governance (new)

| Prefix | Role |
|---|---|
| `SKILL--` | Agent capability / affordance (Claude Code Skills, OpenAI Assistant tools, EVA agent skills). Distinct from `FEAT--` which is user-facing. |
| `PROTOCOL--` | Interaction contract between systems / agents (MCP handshake, agent-to-agent message format). Distinct from `API--` which is endpoint-level. |
| `GUARDRAIL--` | Behavioural constraint enforced at runtime (LLM-side policy, tool-call gate). Distinct from `ADR--` which is decision record. |
| `POLICY--` | Operational policy (RBAC, retention, rate limits). |
| `PERSONA--` | Agent identity / role / system prompt seed. |

### Cluster 3 — Requirements Engineering (new — split from CONCEPT--REQ)

| Prefix | Role |
|---|---|
| `REQ--` | Umbrella requirement (cross-cuts FR + NFR; lives in RTM). |
| `FR--` | Functional requirement — verifiable by unit / E2E tests. |
| `NFR--` | Non-functional requirement (perf / security / scale / availability) — verifiable by load / pen / chaos tests. |
| `CONSTRAINT--` | Hard external constraint (regulatory, contractual). |

### Cluster 4 — Ops Governance (new)

| Prefix | Role |
|---|---|
| `INC--` | Incident post-mortem (consolidated lesson). Distinct from `MSP-INC-` which is the raw event log. |
| `ISSUE--` | **Live, self-hosted issue tracker** — replaces Linear/Jira when desired. Light-governance (see below). |
| `RISK--` | Identified risk + mitigation (preventive — before it becomes an incident). |
| `RUNBOOK--` | Operational response guide ("if X, do Y"). |
| `SLO--` | Service-level objective + alert thresholds. |

### `ISSUE--` is special — two-tier governance

Most atomic types are **set-once-then-stable**: an ADR is reviewed,
promoted, and rarely re-edited. Issues are the opposite — a single
issue gets ten status changes, twenty comments, and three reassignments
during its lifetime. Treating issues with the same write-protect as
ADRs makes self-hosted tracking unworkable.

Therefore `ISSUE--` files live under a **light-governance** track:

| Tier | Atom types | Governance |
|---|---|---|
| **Strict** (`gks/{adrs,blueprints,concepts,frameworks,entities,apis,…}/`) | ADR / BLUEPRINT / CONCEPT / FEAT / FRAME / ENTITY / API / etc. | inbound queue → human review → promote |
| **Light** (`gks/issues/`) | ISSUE-- only (initially) | direct write OK; schema validation enforced; comments are append-only by convention |

GKS still validates schema (status enum, priority enum, assignee
resolves, crosslinks resolve). It just doesn't require human review for
routine status changes / comments. The light-governance tier is opt-in
per directory; nothing else in `gks/` weakens.

### What stays out

- **`SOLUTION--`** is rejected — solutions are ADRs in disguise. Use
  `ADR--xxx` with `crosslinks.resolves: [INC--..., ISSUE--...]`.
- **MSP-INC-** stays in process tracking (event log) — distinct from
  `INC--` (post-mortem atomic).
- **Workflow gates** (CLI commands, pre-commit) stay out of GKS itself
  per ADR-008 — but the CLI helpers for `gks issue *` ship in this repo
  because issue tracking IS storage manipulation, not workflow.

## Consequences

**Positive**

- **No more "where does this go?"** for skills, guardrails, requirements,
  incidents, issues. Every atomic concern has a canonical prefix.
- **Self-hosted issue tracking** removes the "must subscribe to Linear"
  dependency for new projects. Every issue is in the same audit-traced
  knowledge graph as the ADRs that resolve it.
- **Clean traceability across clusters** — `ADR--CIRCUIT-BREAKER`
  resolves `ISSUE--PAYMENT-TIMEOUT` resolves `INC--PAYMENT-Q3`. The
  chain is explicit in `crosslinks` and queryable via existing
  AtomicLayer / `lookupBySymbol` primitives.
- **Better verification fit** — splitting FR/NFR lets reviewers pick
  the right verification approach per requirement.

**Negative**

- **Larger surface** — 30+ prefixes mean more for new contributors to
  learn. Mitigated by `docs/KNOWLEDGE-TYPES.md` + `examples/atom-templates/`
  shipped alongside this ADR.
- **Two-tier governance complexity** — strict vs light is a real
  conceptual addition. The MSP gatekeeper logic gains a per-directory
  decision: "is this in the strict tier or the light tier?"
- **`ISSUE--` lifecycle commands need building** — `gks issue
  new/list/show/comment/status/close` is a substantial CLI addition
  (deferred to a follow-up PR).
- **Some prefixes look similar** to a casual reader (`POLICY--` vs
  `GUARDRAIL--`, `FR--` vs `FEAT--`). The reference doc disambiguates;
  reviewers may still need to push back on misclassification.

## Alternatives considered

1. **Keep the 17-prefix taxonomy + extend per-project.** *Rejected.*
   "Extend per project" is what we've been doing implicitly, and the
   result is taxonomy drift — every EVA-shaped project reinvents
   SKILL/GUARDRAIL/ISSUE with slightly different conventions.

2. **Use Linear/Jira/GitHub Issues for ops, atomic for everything
   else.** *Rejected* by the explicit self-host requirement: "we must
   work without Linear." Also: cross-cluster traceability (ADR resolves
   ISSUE resolves INC) is harder when issues live in a separate system.

3. **Single `OPS--` umbrella prefix instead of INC/ISSUE/RISK/RUNBOOK/SLO.**
   *Rejected.* Lumping operational concerns repeats the
   `CONCEPT--REQ.md` mistake. The five sub-categories have different
   lifecycles, different reviewers, and different validation rules.

4. **Defer the expansion until "more projects use GKS."** *Rejected.*
   Taxonomy stabilises early; adding prefixes later is harder than
   adding them now. The current EVA project already needs all four
   clusters.

5. **Ship `SOLUTION--` for symmetry.** *Rejected.* See above —
   solutions ARE ADRs. Adding the prefix creates ambiguity with no
   information gain.

## What this ADR ships

- `docs/KNOWLEDGE-TYPES.md` — canonical reference for all 30+ prefixes,
  organised by cluster, with "when to use" and "when NOT to use"
  guidance per type.
- `examples/atom-templates/` — minimum-viable starter `.md` templates
  for every prefix, showing the required + recommended frontmatter
  fields plus a body skeleton.
- This ADR records the decision; the corresponding code (ISSUE-- CLI
  commands, schema validation) ships in a separate follow-up PR so the
  reference docs can land + be reviewed independently.

## What this ADR does NOT change

- `AtomicEntry.type` in `src/memory/types.ts` is already
  `string` — no code change needed to support new prefixes.
- `isAtomicId(id)` regex unchanged — it already accepts any
  `TYPE--SLUG` shape.
- All existing ADRs / FEATs / blueprints continue to work unchanged.

## References

- `FRAMEWORK_MASTER_SPEC §4.1` — original 17-prefix taxonomy
- `docs/KNOWLEDGE-TYPES.md` (this PR) — reference doc
- `examples/atom-templates/` (this PR) — starter templates
- ADR 008 — storage scope; this expansion is documentation + templates
  only, no scope change to GKS itself
- ADR 011 — test policy; ISSUE-- CLI commands shipping in the
  follow-up PR will follow this contract
