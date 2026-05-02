---
id: ADR--NAMESPACED-EPISODIC-LOOKUP
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Namespace scoping for `lookupByAtom`
crosslinks: {"parent_concept":["CONCEPT--NAMESPACED-EPISODIC-LOOKUP"],"references":["ADR--REVERSE-EPISODIC-LOOKUP","ADR--EPISODIC-V2"]}
created_at: 2026-05-02T13:22:59.603Z
---

# ADR — Namespace scoping for `lookupByAtom`

## Context

[[CONCEPT--NAMESPACED-EPISODIC-LOOKUP]] motivates honouring the
namespace contract on `lookupByAtom`. Open questions:

1. **What are the option semantics?**
2. **How does namespace matching work for sessions written without a namespace?**
3. **Should `scanEpisodicForAtom` (pure helper) also gain the option, or just the MemoryStore wrapper?**

## Decision

### 1. Same options, same defaults as recall

`MemoryStore.lookupByAtom(atomId, opts?)` accepts:

```ts
interface LookupByAtomOptions {
  predicates?: string[]      // existing
  namespace?: Namespace      // NEW — filter, default = store.defaultNamespace
  crossNamespace?: boolean   // NEW — bypass filter (admin)
}
```

Resolution:

- `crossNamespace: true` → no filter; scan all sessions.
- `namespace: { tenant_id: 'X', ... }` → keep only sessions whose
  `EpisodicSession.namespace` matches every set field.
- neither → use `store.defaultNamespace`.

Matching rule: a session passes the filter when **every key set in
the requested namespace** has the same value on the session's
namespace, OR the requested key is unset. Missing keys on either side
are wildcards (mirrors `namespaceAsFilter`).

### 2. Sessions without a namespace

A session whose `session.json` has no `namespace` field is treated
as belonging to the **empty namespace `{}`**. Under any non-empty
filter, such sessions are excluded — preserving the contract that
SaaS callers see only their own tenant's data.

When `defaultNamespace` itself is `{}` (single-tenant install), no
filtering happens and every session passes — preserves the current
single-tenant behaviour byte-for-byte.

### 3. Where the filter lives

The filter logic lives at the **MemoryStore wrapper** layer, not
inside `scanEpisodicForAtom`. Reasons:

- The pure helper sees a single `EpisodicLayerV2` instance and has
  no concept of `defaultNamespace` (that's a store-level setting).
- Callers using the helper directly (tests, custom orchestrators)
  may want the unfiltered view; making the wrapper apply the filter
  keeps the helper minimal.
- The helper still gets a `predicates` filter; namespace handling
  is a separate concern bolted on top.

`MemoryStore.lookupByAtom` resolves namespace, calls the helper to
get full results, then filters `episodes[]` + `turns[]` by their
`session_id` against an in-memory map of allowed session ids.

### 4. MCP tool extension

`gks_lookup_by_atom` MCP input schema gains optional `namespace` and
`crossNamespace` fields, matching `gks_recall`. The
`gks_recall_cross_namespace` admin gate pattern (separate exposed
tool only when `exposeCrossNamespace: true`) does NOT apply here —
`lookupByAtom` is a less common path, and the `crossNamespace` flag
on the same tool is sufficient gate. Callers who don't pass it get
the safe scoped behaviour.

## Consequences

**Positive:**
- Multi-tenant SaaS installs no longer leak conversational content
  across tenants on the reverse-lookup path.
- Same options + defaults as recall — one mental model.
- No schema change; sessions written today already carry the
  namespace field via `endSession`.

**Negative:**
- Scan still walks every session before filtering (the filter is
  post-scan in memory). For very large stores this is wasteful.
  Mitigated by `_index.jsonl` already living in memory; per-session
  filter is cheap. A future optimization can shard `_index.jsonl`
  by namespace if the cost matters.
- Sessions written before this ADR may lack a `namespace` field;
  they appear as `{}` and won't match any non-empty filter. Tooling
  (`gks episodic migrate`) writes the namespace on re-emit.

**Schema impact:** none on disk. New options on the public API.

## Alternatives considered

1. **Filter inside `scanEpisodicForAtom`.** *Rejected.* The pure
   helper shouldn't know about `defaultNamespace` resolution — that
   belongs to the store wrapper. The helper still accepts the
   in-memory namespace match list if a caller wants to drive it
   directly.
2. **Separate `lookupByAtomCrossNamespace` admin tool** mirroring
   `gks_recall_cross_namespace`. *Rejected.* The flag-on-same-tool
   shape is simpler and the lookup primitive is less of a security
   surface than recall (results carry no semantic ranking, just
   structural references).
3. **Shard `_index.jsonl` by namespace.** *Deferred.* Premature
   optimisation; current single-file index is fine at the scale
   GKS targets. Revisit when episode count justifies it.
