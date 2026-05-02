---
id: CONCEPT--NAMESPACED-EPISODIC-LOOKUP
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — Namespace-scoped reverse episodic lookup
crosslinks: {"references":["CONCEPT--MEMORY-STORE"]}
created_at: 2026-05-02T13:22:58.021Z
---

# CONCEPT — Namespace-scoped reverse episodic lookup

## Problem

`MemoryStore.lookupByAtom(atomId)` (BLUEPRINT--REVERSE-EPISODIC-LOOKUP)
walks **every** v2 session in the episodic store regardless of which
namespace each session was written under. That contradicts the multi-
tenancy contract codified in ADR-004 + applied to recall today (which
honours `defaultNamespace` as a metadata filter unless
`crossNamespace: true` is passed).

In a SaaS deployment where multiple tenants share one GKS instance,
the current `lookupByAtom` leaks across tenants:

- Tenant A asks "where has FEAT--FOO been mentioned?"
- Result includes B's sessions whose Episodes/Turns reference
  FEAT--FOO (because atoms are global by design)
- A sees B's session_ids + turn texts → privacy / contract violation

The atomic layer is intentionally global ([[CONCEPT--MEMORY-STORE]] +
the `gks_lookup` MCP tool's "GLOBAL by design" comment), but the
*conversational* layer carries tenant-private content. Reverse-lookup
results must filter by the active namespace.

## Hypothesis

If `lookupByAtom` accepts the same `namespace` / `crossNamespace`
options recall already exposes (`RetrievalOptions`), then:

1. Default behaviour (no opts) honours `MemoryStore.defaultNamespace`
   — which is `{}` for single-tenant installs and the active tenant
   for SaaS instances. No leak.
2. `crossNamespace: true` opens the scan up — admin / migration paths
   only, mirroring the existing `gks_recall_cross_namespace` MCP
   tool's gate.
3. `namespace: { tenant_id: 'X' }` lets admins query a specific
   tenant explicitly.

This is the natural symmetry with `recall` — same primitives, same
options, same defaults. The fix is small (filter `EpisodicSession`
rows by their stored `namespace` field) and changes no on-disk
schema.
