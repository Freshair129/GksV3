# Architecture Decision Records

Short, dated notes capturing decisions made during the build that aren't
obvious from the code alone. One file per decision; status is one of
`proposed` / `accepted` / `superseded` / `rejected`.

| # | Title | Status | Date |
|---|---|---|---|
| [001](./001-file-based-vector-store.md) | File-based vector store as Phase 1 default | accepted | 2026-04-24 |
| [002](./002-bi-temporal-conflict-resolution.md) | Bi-temporal conflict resolution (valid_to + supersede) | accepted | 2026-04-24 |
| [003](./003-pluggable-backends.md) | Pluggable backend interfaces (VectorBackend / GraphBackend) | accepted | 2026-04-24 |
| [004](./004-namespace-as-first-class.md) | Namespace as first-class isolation key | accepted | 2026-04-25 |
| [005](./005-cut-falkordb.md) | Cut FalkorDB; use Postgres tables for the graph | accepted | 2026-04-25 |
| [006](./006-otel-noop-default.md) | OpenTelemetry with no-op default | accepted | 2026-04-25 |
| [007](./007-mcp-server-stdio-only.md) | MCP server: stdio only for Phase 5 | accepted | 2026-04-25 |
| [008](./008-gks-storage-engine-scope.md) | GKS as storage engine; Memory OS layer above (MSP-shaped contract) | accepted | 2026-04-26 |
| [009](./009-msp-as-orchestrator.md) | MSP orchestrates peer subsystems; GKS does not proxy them | accepted | 2026-04-26 |
| [012](./012-extended-taxonomy.md) | Extended atomic taxonomy + ISSUE-- as self-hosted tracker | accepted | 2026-04-26 |
| [013](./013-flat-atom-layout.md) | Atom folders organised by type, not by phase | accepted | 2026-04-27 |
| [010](./010-reverse-citation-lookup.md) | Bidirectional traceability via reverse citation lookup | accepted | 2026-04-26 |
| [011](./011-test-policy.md) | Test policy: when written, when run, what's required | accepted | 2026-04-26 |
| [014](./014-doc-to-code-enforcement.md) | Doc-to-code enforcement model (master-spec §6 → GKS primitives) | accepted | 2026-04-28 |
| [015](./015-task-tracking-at-orchestrator.md) | Task tracking belongs to the orchestrator, not GKS (supersedes ADR-014 item 1) | accepted | 2026-04-28 |
| [016](./016-postpone-kuzu-backend.md) | Postpone embedded graph backend (Kuzu) | accepted | 2026-04-28 |

## Promotion to gks/

ADRs in this directory are the working reference. Once an ADR is
`accepted` and the implementation lands, copy it into the inbound queue
(`npm run gks` → `propose-inbound`) so it can be promoted to
`gks/adr/<slug>.md` after human review. We never write
to `gks/` directly — that's the rule from `BLUEPRINT--memory`
§ write_rules, and ADRs are no exception.
