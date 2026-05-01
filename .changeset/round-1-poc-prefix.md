---
'@evaai/gks': minor
---

Add `POC--` prefix — time-boxed hypothesis-test atom (light-tier).

Closes the gap where `examples/<name>/` directories labelled
"proof-of-concept" had no atom recording their hypothesis, deadline,
or outcome. Mirrors the `HOTFIX--` light-tier pattern: direct write,
schema-validated, lifecycle-enforced (`open → running → validated /
invalidated / abandoned`), pre-commit hook blocks on overdue.

User-visible additions:

- Taxonomy: `'poc'` added to `AtomicType`; `KNOWLEDGE-TYPES.md`
  Cluster 1 entry; `examples/atom-templates/POC.md`
- Storage primitives: `PocStore` (open / start / close / list /
  listOverdue), `validatePoc`, `isOverdue`, `isClosed`,
  `promotePocToAdr`
- CLI: `gks poc open / start / close / list / check /
  promote-to-adr`; `--timing` flag on `hotfix check` + `poc check`
- MCP tools: `gks_poc_open`, `gks_poc_start`, `gks_poc_list`,
  `gks_poc_close` (4 of the 10 new MCP tools shipped — the other 6
  are `gks_issue_*` mirrors of the existing ISSUE-- CLI)
- Pre-commit gate: `examples/drift-detection/hotfix-gate.sh` now
  runs both `hotfix check` and `poc check`

Related ADRs / atoms shipped alongside:

- `ADR--ADD-POC-PREFIX` — the proposal
- `FEAT--POC-LIGHT-TIER` — the dogfood feature atom
- `POC--MEMORY-OS-ARCHITECTURE` — backfill (status: validated)
- `POC--POC-OVERDUE-CI-INTEGRATION` — first running POC

MCP server tool count grows 13 → 23 over this batch.
