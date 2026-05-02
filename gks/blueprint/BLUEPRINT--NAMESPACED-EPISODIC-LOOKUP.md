---
id: BLUEPRINT--NAMESPACED-EPISODIC-LOOKUP
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Namespace scoping for `lookupByAtom`
crosslinks: {"parent_adr":["ADR--NAMESPACED-EPISODIC-LOOKUP"],"parent_concept":["CONCEPT--NAMESPACED-EPISODIC-LOOKUP"]}
linked_symbols:
  - {"file":"src/memory/episodic-v2.ts","fn":"matchesNamespace"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.lookupByAtom"}
  - {"file":"src/mcp-server/index.ts","fn":"gks_lookup_by_atom"}
  - {"file":"bin/gks.ts","fn":"cmdEpisodicLookup"}
created_at: 2026-05-02T13:23:01.348Z
---

# BLUEPRINT — Namespace scoping for `lookupByAtom`

```yaml
metadata:
  title: "Namespace-scoped reverse episodic lookup"
  status: draft

architectural_pattern: |
  Add LookupByAtomOptions = {predicates?, namespace?, crossNamespace?}.
  MemoryStore.lookupByAtom resolves the effective namespace (call >
  store default), runs scanEpisodicForAtom, then filters
  episodes/turns by their session's namespace. Pure helper unchanged.

data_logic: |
  matchesNamespace(sessionNs, filterNs):
    if !filterNs or Object.keys(filterNs).length === 0: return true
    for [k, v] in Object.entries(filterNs):
      if v === undefined: continue
      if (sessionNs?.[k]) !== v: return false
    return true

  MemoryStore.lookupByAtom(atomId, opts):
    const effectiveNs = opts.crossNamespace
      ? null            // bypass filter
      : opts.namespace ?? this.defaultNamespace

    // Build allowed-session set up-front to avoid per-result lookups.
    const allowed = new Set<string>()
    for s in this.episodicV2.listSessions():
      const sess = this.episodicV2.readSession(s.session_id)
      if !effectiveNs || matchesNamespace(sess?.namespace, effectiveNs):
        allowed.add(s.session_id)

    const result = scanEpisodicForAtom(this.episodicV2, atomId, opts)
    if !effectiveNs: return result      // crossNamespace path

    return {
      ...result,
      episodes: result.episodes.filter(e => allowed.has(e.session_id)),
      turns:    result.turns.filter(t => allowed.has(t.session_id)),
    }

geography:
  - "src/memory/episodic-v2.ts"           # export matchesNamespace + types
  - "src/memory/index.ts"                 # MemoryStore.lookupByAtom rewrites
  - "src/mcp-server/index.ts"             # MCP input schema extension
  - "bin/gks.ts"                          # `--namespace` / `--cross-namespace` CLI flags
  - "test/memory/reverse-episodic.test.ts" # extend with V1-V7

api_contracts:
  - name: "LookupByAtomOptions"
    file: "src/memory/episodic-v2.ts"
    shape: |
      interface LookupByAtomOptions {
        predicates?: string[]
        namespace?: Namespace        // NEW
        crossNamespace?: boolean     // NEW
      }

  - name: "matchesNamespace"
    file: "src/memory/episodic-v2.ts"
    shape: |
      function matchesNamespace(
        sessionNs: Namespace | undefined,
        filterNs: Namespace,
      ): boolean

  - name: "MemoryStore.lookupByAtom (extended)"
    file: "src/memory/index.ts"
    shape: |
      lookupByAtom(atomId: string, opts?: LookupByAtomOptions): Promise<LookupByAtomResult>

verification_plan:
  - id: V1-default-scoped-to-defaultNamespace
    description: |
      MemoryStore({ defaultNamespace: { tenant_id: 'A' } }).lookupByAtom('FEAT--X')
      returns only refs from sessions whose namespace.tenant_id === 'A'.
      Sessions belonging to tenant B are excluded.
  - id: V2-empty-defaultNamespace-no-filter
    description: |
      MemoryStore({ defaultNamespace: {} }).lookupByAtom('FEAT--X') returns
      every match (single-tenant default — current behaviour preserved).
  - id: V3-explicit-namespace-overrides-default
    description: |
      With defaultNamespace = { tenant_id: 'A' } but lookupByAtom(id,
      { namespace: { tenant_id: 'B' } }) returns only B's matches.
  - id: V4-crossNamespace-true-bypasses-filter
    description: |
      lookupByAtom(id, { crossNamespace: true }) returns every match
      regardless of namespace. Same as the pre-change behaviour.
  - id: V5-session-without-namespace-treated-as-empty
    description: |
      A session whose session.json has no namespace field is excluded
      from a non-empty filter, included in an empty filter
      (defaultNamespace = {}).
  - id: V6-predicates-filter-still-applies
    description: |
      With opts.predicates=['implements'] AND a namespace filter,
      both filters compose — only entries matching BOTH predicate
      AND namespace are returned.
  - id: V7-cli-and-mcp-flags
    description: |
      `gks episodic lookup ATOM--ID --namespace=tenant_id=A` filters
      to tenant A. `--cross-namespace` bypasses. `gks_lookup_by_atom`
      MCP tool accepts the same args.

implementation_steps:
  - 1. Export matchesNamespace + LookupByAtomOptions from episodic-v2.ts.
  - 2. Rewrite MemoryStore.lookupByAtom to apply the filter post-scan.
  - 3. Extend MCP tool input schema with `namespace` + `crossNamespace`.
  - 4. CLI: parse `--namespace=key=value,key2=value2` into a Namespace
       object; add `--cross-namespace` boolean.
  - 5. Tests V1-V7. No breaking changes for existing tests
       (defaultNamespace stays {} in fixtures).
```
