# ADR 009 — MSP orchestrates peer subsystems; GKS does not proxy them

- **Status:** accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Context tag:** scope, msp, gitnexus, layering, orchestration

## Context

ADR-008 settled the vertical layering: GKS = storage engine, MSP = Memory
OS above. Almost immediately a horizontal question appeared: a second
subsystem with overlapping shape entered the picture — **GitNexus**, an
MCP-native code-intelligence engine that indexes a repo into an AST /
call-graph and exposes its own retrieval tools.

Two integration patterns surfaced:

**Pattern 1 — Linear chain.** MSP → GKS → GitNexus. GKS embeds (or
proxies) GitNexus's retrieval tools so MSP only ever talks to GKS, and
GKS internally fans out to GitNexus when a code-graph question arrives.

**Pattern 2 — Orchestrator.** MSP → GKS *and* MSP → GitNexus, as peer
subsystems. MSP decides which one to ask (or both, in parallel) for any
given query and merges results.

The question generalises beyond GitNexus: any future peer subsystem
(observability stores, vector-search-as-a-service, memory caches,
domain-specific KBs) hits the same fork.

## Decision

Adopt **Pattern 2.** MSP — or any Memory OS layer that pairs with GKS —
orchestrates peer subsystems. **GKS does not proxy other engines.**

Concretely:

1. **GKS imports nothing from GitNexus.** No optional dependency, no
   adapter inside `src/`, no MCP-tool-that-fans-out.
2. **MSP holds two MCP clients** (one for `gks-mcp-server`, one for
   `gitnexus mcp`) and routes per query. Cross-system correlation
   (e.g. "ADR-007 plus impact analysis on its `linked_symbols`") is
   MSP's job — fan out, merge, return.
3. **Atomic notes can reference symbols** via a frontmatter field
   (`linked_symbols: [{ file, fn }, ...]`). MSP resolves these by
   calling GitNexus; GKS only stores the reference text.
4. **Caching code-graph data into GKS's `GraphBackend` is allowed
   and does NOT count as Pattern 1.** Periodically exporting GitNexus
   edges into GKS as cached snapshots is a denormalisation for fast
   reads, not a dependency. MSP owns the sync; GKS treats the rows as
   ordinary data.

This generalises: **any future peer subsystem is wired the same way.**
GKS stays focused on storage; MSP stays focused on orchestration; each
peer stays focused on its specialty.

## Consequences

**Positive**

- **No coupling between peers.** GKS is usable without GitNexus;
  GitNexus is usable without GKS. A team can adopt either independently.
- **Each subsystem owns its specialty.** GitNexus tracks language
  parsers, AST changes, call-graph algorithms. GKS tracks vector
  backends, retrieval merging, audit. Neither has to learn the other's
  domain.
- **Composition is free via MCP.** Claude Code already merges tool
  surfaces from multiple MCP servers, so the agent picks the right
  tool per question without MSP doing anything special. MSP's job is
  to host the *correlation* logic when an answer requires combining
  signals.
- **Scope-creep guardrail.** ADR-008 + this ADR together give a clear
  answer to "should GKS know about X?" — almost always *no*, X belongs
  to a peer or to MSP.
- **Future-proof for new peers.** Adding observability search,
  external KBs, code-search engines, or anything else follows the same
  recipe: peer subsystem + MCP surface + MSP-side router entry.

**Negative**

- **MSP carries the routing complexity.** It must know two query
  shapes (GKS's verbs + GitNexus's tools) and own the correlation
  logic. The win is that this complexity is in the *one* place where
  it belongs (the orchestrator), not smeared across storage engines.
- **No single MCP endpoint that "does everything."** Operators run
  two servers in their MCP config. We accept this; the gain is per-
  subsystem versioning + independent deployment.
- **Cross-system queries pay a fan-out cost.** Two RPCs vs one. In
  practice negligible (stdio MCP is sub-ms) and parallel-able.

## Alternatives considered

1. **Pattern 1 — GKS proxies GitNexus.** *Rejected.* Violates ADR-008
   ("code intelligence → use GitNexus" is out of scope), forces every
   GKS user to install GitNexus, mixes paradigms (storage engine +
   AST analyser), couples versioning, and makes correlation logic
   leak into GKS.

2. **Single mega-server hosting both.** *Rejected.* A "memory + code"
   server still has both responsibilities under one roof; doesn't
   solve the coupling, just hides it.

3. **Sidecar adapter inside GKS** (separate file, optional import).
   *Rejected.* Optional imports drift into hard imports under pressure;
   the cleanest line is "no GitNexus reference inside `src/` at all."

4. **Defer the decision** ("we'll figure it out when someone asks").
   *Rejected* in light of how easy it would be to slip a one-line
   import into `src/memory/` and start the slide. The ADR exists
   precisely to make the slide visible.

## What this looks like in practice

```
┌─────────────────────────────────────────────────────┐
│ Agent (Claude Code / Cursor / custom)               │
└─────────────────────────┬───────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│ MSP — Memory OS / orchestrator                      │
│   • holds clients for: GKS, GitNexus, ...           │
│   • routes per query.type                           │
│   • runs cross-system correlation when asked        │
└────────────────┬────────────────┬───────────────────┘
                 │                │
       ┌─────────▼──────┐  ┌──────▼─────────────┐
       │ GKS            │  │ GitNexus           │
       │ memory storage │  │ code AST + graph   │
       └────────────────┘  └────────────────────┘
       (and any future peer subsystem follows the same pattern)
```

Worked example — agent asks *"What does ADR-007 say, and what would
break if I refactor the function it governs?"*:

```
agent → MSP
         ├── GKS.lookup("ADR-007")        ← parallel
         └── GitNexus.impact("formatStep")  ← parallel (symbol from ADR's linked_symbols)
        merged response back to agent
```

GKS knows nothing about `formatStep`. GitNexus knows nothing about
`ADR-007`. MSP knows both *exist* and how to combine them.

## References

- `SCOPE.md` — out-of-scope: code intelligence
- `docs/MSP_RELATIONSHIP.md` § "Coexisting with peer subsystems"
- `README.md` § "Pairing with a code-structure layer (GitNexus)"
- ADR 008 — GKS as storage engine; Memory OS layer above (the vertical
  layering this ADR builds on)
- ADR 003 — Pluggable backends (the same "narrow contract" philosophy
  applied to storage internals; this ADR applies it to peer subsystems)
