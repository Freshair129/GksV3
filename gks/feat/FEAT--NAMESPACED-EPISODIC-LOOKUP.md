---
id: FEAT--NAMESPACED-EPISODIC-LOOKUP
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Namespace-scoped reverse episodic lookup
crosslinks: {"parent_concept":["CONCEPT--NAMESPACED-EPISODIC-LOOKUP"],"parent_adr":["ADR--NAMESPACED-EPISODIC-LOOKUP"],"parent_blueprint":["BLUEPRINT--NAMESPACED-EPISODIC-LOOKUP"]}
linked_symbols:
  - {"file":"src/memory/episodic-v2.ts","fn":"matchesNamespace"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.lookupByAtom"}
  - {"file":"src/mcp-server/index.ts","fn":"gks_lookup_by_atom"}
  - {"file":"bin/gks.ts","fn":"cmdEpisodicLookup"}
created_at: 2026-05-02T13:23:02.987Z
---

# FEAT — Namespace-scoped reverse episodic lookup

## User-facing behaviour

> Given a multi-tenant `MemoryStore({ defaultNamespace: { tenant_id: 'A' } })`,
> when an agent calls `store.lookupByAtom('FEAT--FOO')`,
> then results contain only refs from sessions written under tenant
> A — tenant B's sessions are filtered out.

> Given an admin who needs cross-tenant analytics,
> when they call `store.lookupByAtom('FEAT--FOO', { crossNamespace: true })`,
> then GKS returns every reference regardless of namespace (matches
> the pre-change behaviour for single-tenant installs).

> Given the CLI: `gks episodic lookup FEAT--FOO --namespace=tenant_id=A`,
> when run on a multi-tenant store,
> then only tenant A's matches are listed.

## Acceptance criteria

- [ ] **AC1**: `LookupByAtomOptions` gains optional `namespace` and
      `crossNamespace` fields per BLUEPRINT.
- [ ] **AC2**: Default behaviour (no opts) honours
      `MemoryStore.defaultNamespace`. Sessions outside the active
      namespace are filtered from `episodes[]` and `turns[]`.
- [ ] **AC3**: With `defaultNamespace = {}` (single-tenant default),
      no filtering occurs — every existing test from
      reverse-episodic.test.ts passes unmodified.
- [ ] **AC4**: `crossNamespace: true` bypasses the filter (admin path).
- [ ] **AC5**: An explicit `namespace` overrides `defaultNamespace`.
- [ ] **AC6**: Sessions without a `namespace` field on their
      `session.json` count as the empty namespace `{}` — included
      under empty filters, excluded under non-empty ones.
- [ ] **AC7**: `predicates` filter still applies and composes with
      the namespace filter (both filters logical AND).
- [ ] **AC8**: `gks_lookup_by_atom` MCP tool input gains optional
      `namespace` (object with tenant_id/user_id/session_id/agent_id)
      + `crossNamespace` boolean.
- [ ] **AC9**: `gks episodic lookup ATOM--ID` CLI accepts
      `--namespace=key=value,key2=value2` and `--cross-namespace`.
- [ ] **AC10**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests in `test/memory/reverse-episodic.test.ts`.

## Out of scope

- Sharding `_index.jsonl` by namespace. Mentioned in ADR as a
  deferred optimisation; current single-file scan is fine at scale.
- Filtering / namespacing on `summarizeCommunity` /
  `detectCommunities`. Atoms are global by design (per
  `gks_lookup` MCP tool description); the conversational layer is
  the only one that carries tenant-private content.
- Migration tool to backfill `namespace` on existing v2 sessions
  written before this ADR. Sessions without namespace just count as
  `{}` — `gks episodic migrate` already writes the field on re-emit.
