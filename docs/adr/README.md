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

## Promotion to gks/

ADRs in this directory are the working reference. Once an ADR is
`accepted` and the implementation lands, copy it into the inbound queue
(`npm run gks` → `propose-inbound`) so it can be promoted to
`gks/phase2_atomic/concept/adr-*.md` after human review. We never write
to `gks/` directly — that's the rule from `BLUEPRINT--memory`
§ write_rules, and ADRs are no exception.
