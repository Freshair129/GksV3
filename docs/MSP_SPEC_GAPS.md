# MSP Spec — Gap Analysis & Improvement Plan

> **Companion to** [`MSP_RELATIONSHIP.md`](./MSP_RELATIONSHIP.md).
> **Source of truth (external):** [`Freshair129/msp/msp_spec.md`](https://github.com/Freshair129/msp/blob/main/msp_spec.md) v1.0.0.
> **Audit date:** 2026-05-03.
> **Verdict:** ~80% compatible. Three adapter shims required; one architectural decision pending.

---

## 0. How to read this doc

- **P0** = blocks MSP from being used as-is against the current GKS tree.
- **P1** = causes silent drift (wrong dirs, wrong IDs); not a hard crash but rots the SSOT.
- **P2** = nice-to-have alignment; either side can absorb.
- Each gap names **owner** (`gks` / `msp` / `joint`), **effort** (`S`/`M`/`L`), and **fix shape**.

---

## 1. P0 — Path mapping mismatch (singular vs plural)

| | Detail |
|---|---|
| **Symptom** | `scripts/msp/promote.mjs` writes to `gks/adrs/`, `gks/concepts/`, `gks/blueprints/`, `gks/features/`, … but GKS expects `gks/adr/`, `gks/concept/`, `gks/blueprint/`, `gks/feat/` (per [ADR-013-FLAT-ATOM-LAYOUT](./adr/013-flat-atom-layout.md)) |
| **Affected types** | `adr`, `algo`, `entity`, `feat`/`features`, `flow`, `frame`/`framework`, `mod`/`module`, `params`/`parameter`, `concept`, `idea`, `blueprint`, `api` |
| **Owner** | `msp` (preferred) or `joint` (alias both) |
| **Effort** | S (table edit) |
| **Fix** | Update `scripts/msp/promote.mjs` `TYPE → DIR` map: `ADR → gks/adr`, `CONCEPT → gks/concept`, `BLUEPRINT → gks/blueprint`, `FEAT → gks/feat`, `ALGO → gks/algo`, `ENTITY → gks/entity`, `FLOW → gks/flow`, `FRAME → gks/frame`, `MOD → gks/module`, `PARAMS → gks/params`. Mirror change in MSP `re-indexer.mjs`. |
| **Verification** | After fix: `npm run msp:promote` followed by `gks validate --links --root=.` exits 0 with files in expected dirs. |

---

## 2. P0 — Type taxonomy enum is too narrow

| | Detail |
|---|---|
| **Symptom** | MSP `phase2_atomic_contract.yaml` `type` enum lists only `architecture_decision, feature, module, protocol, flow` (5). Promote map adds 7 more. GKS taxonomy ([CLAUDE.md](../CLAUDE.md), [docs/KNOWLEDGE-TYPES.md](./KNOWLEDGE-TYPES.md)) defines **19 types** including `AUDIT, FR, NFR, ISSUE, HOTFIX, INC, GUARDRAIL, RISK, RUNBOOK, SLO, SKILL, PROTOCOL`. |
| **Impact** | Any GKS atom with a type outside MSP's enum → validator rejects the inbound proposal. P6 `AUDIT--` cannot be promoted. Hotfix flow cannot write `HOTFIX--`. |
| **Owner** | `msp` |
| **Effort** | S (yaml extension) |
| **Fix** | Extend `phase2_atomic_contract.yaml` enum to include all GKS types per [`docs/KNOWLEDGE-TYPES.md`](./KNOWLEDGE-TYPES.md). Suggested addition: `audit, functional_requirement, non_functional_requirement, issue, hotfix, incident, guardrail, risk, runbook, slo, skill, protocol`. |
| **Verification** | `gks new-feature` → `propose-inbound` → MSP validator passes for each emitted candidate. |

---

## 3. P1 — ID format dual-track (`ADR-NNN` vs `ADR--SLUG`)

| | Detail |
|---|---|
| **Symptom** | MSP §4.4 regex accepts both `ADR-[0-9]{3}` and `TYPE--[a-z0-9-]+`. GKS `ATOMIC_ID_PATTERN` accepts only `TYPE--SLUG`. The `no_invented_adr_numbers` rule (`adr_id_must_be_max_plus_one`) is a no-op for slug-based IDs. |
| **Risk** | Mixed history: legacy `ADR-079` files coexist with new `ADR--FOO`. `lookup` tools assume one convention; reverse lookup may silently miss legacy IDs. |
| **Owner** | `joint` |
| **Effort** | M (decide + migrate) |
| **Fix** | **Decision needed:** (a) drop `ADR-NNN` from MSP regex going forward, or (b) widen `ATOMIC_ID_PATTERN` in `src/memory/atomic-id.ts` to accept both. Recommendation: (a) — the slug form is more searchable, more namespace-safe, and matches every other GKS type. Provide a one-shot migration script for any existing `ADR-NNN` files. |
| **Verification** | `gks validate --links --root=.` exits 0; no `Invalid ID format` errors. |

---

## 4. P1 — Phase model divergence at P1/P2

| | Detail |
|---|---|
| **GKS** ([ADR-014](./adr/014-doc-to-code-enforcement.md)) | P1 = `CONCEPT--`, P2 = `ADR--`, P3 = `BLUEPRINT--`, P4 = `FEAT--`, P5 = code, P6 = `AUDIT--`. |
| **MSP** (§6.2-6.3) | P1 = Tech Feasibility (concept + high-level API draft). **P2 = mandatory OpenAPI** split into 3 atoms: `API--` (master spec), `ENDPOINT--` (1 path/method per file), `ENTRYPOINT--` (auth/middleware). |
| **Risk** | MSP rejects any P2 candidate that isn't an `API--/ENDPOINT--/ENTRYPOINT--`; GKS `new-feature` scaffolds `ADR--` at P2 → blocked. |
| **Owner** | `joint` (architectural call) |
| **Effort** | L (taxonomy + scaffolder + ADR) |
| **Options** | (1) Adopt MSP's P2-OpenAPI mandate: add `API/ENDPOINT/ENTRYPOINT` types to GKS taxonomy; teach `new-feature` to emit them when feature is HTTP-shaped. (2) Relax MSP P2 to `ADR-or-API`. (3) Allow per-project profile (`api_first: true`) selecting between modes. |
| **Recommendation** | Option (3) — write a new ADR `ADR--PHASE-MODEL-PROFILE` capturing the toggle; default profile keeps ADR-014 semantics. |

---

## 5. P1 — Episodic schema ahead of MSP spec

| | Detail |
|---|---|
| **GKS** | EPISODIC-V2 = 3-doc split (`session.json` + `episodes.jsonl` + `turns.jsonl`), with typed crosslinks, semantic frames, persisted reverse atom-index (`_atom_refs.jsonl`). See [`src/memory/episodic-v2.ts`](../src/memory/episodic-v2.ts), [`src/memory/episodic-atom-index.ts`](../src/memory/episodic-atom-index.ts). |
| **MSP** (§7.1-7.2) | Linear sessions JSONL + a single rich `episodic_memory.json` summary. No turn-level granularity, no frames, no reverse index. |
| **Risk** | An MSP impl reading `sessions/<id>.jsonl` will not find GKS v2 layout → 0 episodic recall. |
| **Owner** | `msp` (catch up) or `gks` (provide v1-compat exporter) |
| **Effort** | M |
| **Fix** | Either: (a) update MSP §7 to consume v2 layout, OR (b) add `gks episodic export-v1 --session <id>` to flatten v2 → MSP-shaped JSON for backward compat. Recommendation: (a) — v2 is strictly richer; MSP gets more for free. |

---

## 6. P2 — Path encoding (`D--<name>` vs bare)

| | Detail |
|---|---|
| **MSP spec §12** | Convention is `~/.brain/msp/projects/D--<name>/` |
| **MSP scripts** | Actual `standardizer.mjs` writes bare `~/.brain/msp/projects/<name>/` |
| **GKS `gksLayout()`** | Bare `<path>` (matches scripts) |
| **Status** | Already harmonised in practice — spec has `TODO` note (§12). |
| **Fix** | MSP-side cleanup: update spec §12 to match scripts. **No GKS work required.** |

---

## 7. P2 — `backlinks.jsonl` derived index

| | Detail |
|---|---|
| **MSP §7.3** | Expects `vector/backlinks.jsonl` with `{from, to, type}` edges for hybrid retrieval (RRF). |
| **GKS** | Crosslinks live inside atom frontmatter; exposed via `validateLinks()` and `lookupBySymbol()`. No `backlinks.jsonl` written. |
| **Status** | `scripts/msp/lib/crosslink.mjs` already derives backlinks at re-index time — this is MSP's responsibility per the contract. |
| **Fix** | None on GKS side. Documenting only. |

---

## 8. P2 — Legacy file exemption (`legacy: true`)

| | Detail |
|---|---|
| **MSP §10.2** | Files with `legacy: true` frontmatter bypass strict validation, flagged in report. |
| **GKS** | No equivalent flag. Uses `valid_to` + atom status (`deprecated`, `superseded`) for lifecycle. |
| **Risk** | Importing a legacy MSP project into a GKS-only consumer → unflagged validation errors. |
| **Owner** | `gks` (low priority) |
| **Effort** | S |
| **Fix** | Add an optional `legacy: true` passthrough field to `frontmatter.ts` schema and document the semantics ("MSP-side exemption marker; GKS treats as no-op"). |

---

## 9. Decided non-issues (no action)

| Item | Why not a gap |
|---|---|
| **Codegen micro-task contract** (MSP §5) | Out of GKS scope per [ADR-015](./adr/015-task-tracking-at-orchestrator.md). MSP owns it. |
| **CLI namespace** (`npm run msp:*` vs `gks ...`) | Tools coexist intentionally — MSP orchestrates, GKS accesses storage directly. |
| **Process artifact IDs** (`MSP-IMP-`, `MSP-TSK-`, …) | Live outside `gks/` per design. Already aligned. |
| **Hotfix 48h backfill** | Both sides agree on 48h. `HotfixStore` matches MSP §10.1 verbatim. |
| **Forbidden fields** (commit_hash, …) | GKS deliberately doesn't enforce — MSP owns it. Boundary respected. |

---

## 10. Action checklist (rolled up)

### MSP-side (file upstream issues against `Freshair129/msp`)

- [ ] **P0**: Update `promote.mjs` + `re-indexer.mjs` directory mapping to singular form (gap §1).
- [ ] **P0**: Extend `phase2_atomic_contract.yaml` `type` enum with the 12 missing GKS types (gap §2).
- [ ] **P1**: Decide ID format policy; if dropping `ADR-NNN`, update §4.4 regex + `validator.mjs` (gap §3).
- [ ] **P1**: Either reconcile P2 model with GKS or accept profile toggle (gap §4).
- [ ] **P1**: Update §7 to consume EPISODIC-V2 layout (gap §5).
- [ ] **P2**: Harmonise §12 path-encoding text with actual scripts (gap §6).

### GKS-side (this repo)

- [ ] **P1**: If profile-toggle path chosen for §4 — write `ADR--PHASE-MODEL-PROFILE` and add `api_first` flag to `new-feature` scaffolder.
- [ ] **P1**: If §3 chooses dual-format — widen `ATOMIC_ID_PATTERN` in [`src/memory/atomic-id.ts`](../src/memory/atomic-id.ts).
- [ ] **P1**: If §5 chooses GKS-side compat exporter — add `gks episodic export-v1` subcommand.
- [ ] **P2**: Add `legacy: true` passthrough field to frontmatter schema (gap §8).
- [ ] **P2**: Append a "Known divergences" section to [`MSP_RELATIONSHIP.md`](./MSP_RELATIONSHIP.md) pointing at this doc.

### Joint

- [ ] Open a tracking issue: *"MSP ↔ GKS spec alignment v1.1"* listing the P0 + P1 items above.
- [ ] After P0 fixes land in MSP, run `gks validate --links --root=.` against a project that uses both — must exit 0.

---

## 11. References

- [`MSP_RELATIONSHIP.md`](./MSP_RELATIONSHIP.md) — design contract (what GKS expects from MSP).
- [`adr/013-flat-atom-layout.md`](./adr/013-flat-atom-layout.md) — singular folder decision.
- [`adr/014-doc-to-code-enforcement.md`](./adr/014-doc-to-code-enforcement.md) — phase model.
- [`adr/015-task-tracking-at-orchestrator.md`](./adr/015-task-tracking-at-orchestrator.md) — what MSP owns vs GKS.
- External: [`Freshair129/msp/msp_spec.md`](https://github.com/Freshair129/msp/blob/main/msp_spec.md) v1.0.0 (audited 2026-05-03).
