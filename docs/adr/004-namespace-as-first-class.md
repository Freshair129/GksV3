# ADR 004 — Namespace as first-class isolation key

- **Status:** accepted
- **Date:** 2026-04-25
- **Deciders:** core
- **Context tag:** multi-tenancy, security, retain, recall

## Context

Phase 1 had a soft `RetrievalOptions.namespace` filter — informally a
metadata predicate. Multi-tenant deployments needed it to be a hard
isolation boundary: tenant A's recall must never see tenant B's docs by
accident, and tenant A's retain must never supersede tenant B's docs.

## Decision

Promote `Namespace` to a first-class type:

```ts
interface Namespace {
  tenant_id?: string
  user_id?: string
  session_id?: string
  agent_id?: string
}
```

- `MemoryStoreOptions.defaultNamespace` is the active scope; per-call
  `namespace` overrides it; `crossNamespace: true` opts out (admin).
- `retain()` stamps the active namespace onto doc metadata.
- `retrieve()` filters every source (vector, episodic, obsidian) to the
  active namespace by default.
- **Conflict resolution is namespace-scoped** — `supersede` only
  considers same-namespace docs. (Regression fix: this was a real
  cross-tenant bug latent in the previous code path.)
- Audit log stamps the namespace on every event; `crossNamespace`
  recall stamps `meta.cross_namespace=true` so anomalies are
  visible in post-hoc review.

## Consequences

**Positive**
- Cross-tenant data leakage now requires an explicit opt-in
  (`crossNamespace: true`) and is auditable.
- One MemoryStore instance per request can scope to a tenant cleanly.
- Composite key — tenant + user + session + agent — handles every
  isolation pattern we've seen (per-tenant, per-user-within-tenant,
  per-session-within-user, etc.).

**Negative**
- `RetainInput.sessionId` is now legacy (kept working — it maps to
  `namespace.session_id`). New code should use `namespace`.
- One more option on the giant `MemoryStoreOptions`. We considered
  splitting MemoryStoreOptions into smaller bags (multi-tenancy,
  storage, telemetry) but defer to Phase 6.

## References

- `src/memory/types.ts` — `Namespace`
- `src/memory/api.ts` — `applyNamespace`, namespace-scoped `resolveConflicts`
- `test/memory/namespace.test.ts` — isolation tests
