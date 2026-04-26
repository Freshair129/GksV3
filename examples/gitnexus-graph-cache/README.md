# GitNexus → GKS GraphBackend cache

> Reference adapter showing the **denormalisation pattern** that ADR-009
> authorises: GitNexus owns the canonical AST / call-graph; an
> orchestrator (e.g. MSP) periodically exports it into GKS's
> `GraphStore` so subsequent reads serve from GKS without an MCP
> round-trip.

This is **not** a runtime dependency. GKS still knows nothing about
GitNexus — it just receives nodes + edges as data. The orchestrator
owns the sync timing.

## Why this is allowed

[ADR-008](../../docs/adr/008-gks-storage-engine-scope.md) put GKS
under MSP. [ADR-009](../../docs/adr/009-msp-as-orchestrator.md) put
GKS *next to* GitNexus, not chained. Both rule out "GKS calls
GitNexus on the read path." But ADR-009 calls out one explicit
exception:

> *Caching code-graph data into GKS's `GraphBackend` is allowed and
> does NOT count as Pattern 1. Periodically exporting GitNexus edges
> into GKS as cached snapshots is a denormalisation for fast reads,
> not a dependency. MSP owns the sync; GKS treats the rows as
> ordinary data.*

This directory is the worked example of that exception.

## Files

```
examples/gitnexus-graph-cache/
├── README.md                            # you are here
├── sync.ts                              # GitNexus export → GraphStore
├── query-cached.ts                      # demo reads against the cache
└── fixtures/
    └── gitnexus-export.example.json     # mock export (7 nodes, 5 edges)
```

## End-to-end demo

```sh
# 1. Sync the (mocked) GitNexus export into a GKS graph file
tsx examples/gitnexus-graph-cache/sync.ts \
    --graph=/tmp/eva/graph/code.jsonl

# 2. Ask "what does retain() transitively call (depth 3)?"
tsx examples/gitnexus-graph-cache/query-cached.ts \
    --graph=/tmp/eva/graph/code.jsonl \
    --seed=fn:src/memory/api.ts:retain \
    --depth=3

# Output:
#   seed: fn:src/memory/api.ts:retain
#   reached 3 node(s) at depth ≤ 3 (out)
#
#   · fn:src/memory/inbound.ts:propose                 [calls]
#   ·· fn:src/memory/inbound.ts:renderArtifactMarkdown  [calls → calls]
#   ··· fn:src/lib/yaml-lite.ts:yamlLite                [calls → calls → calls]
```

Reverse direction works too — *"who calls `yamlLite`?"*:

```sh
tsx examples/gitnexus-graph-cache/query-cached.ts \
    --graph=/tmp/eva/graph/code.jsonl \
    --seed=fn:src/lib/yaml-lite.ts:yamlLite \
    --depth=3 --direction=in
```

## What gets stamped

Every node and edge written by `sync.ts` carries:

```json
{
  "source": "gitnexus",
  "synced_at": "<ISO-8601>",
  "codebase_sha": "<git-sha-at-export-time>"
}
```

This is enough for the orchestrator to:

- detect stale data (`codebase_sha` ≠ HEAD → resync needed)
- ignore non-`gitnexus` rows when looking at code-only questions
- audit when a given edge entered the cache

## Bi-temporal "what did the call graph look like on date X?"

`sync.ts` calls `addEdge({ supersede: true })` so each new run marks
the previous sync's same-`(from,to,rel)` edges as `valid_to=now`
without deleting them. Then `query-cached.ts --as-of=<ISO>` walks
only the edges that were valid at that point in time — useful for
reasoning about pre-refactor state.

## Wiring this to a real GitNexus

The example uses a hand-written JSON fixture so it runs offline.
For a real deployment, replace step 1 with:

```sh
# 1a. Pull the call graph out of GitNexus (any of the three works)
gitnexus export --format=json > /tmp/gitnexus.json
# OR
mcp call gitnexus cypher 'MATCH (a)-[r:calls]->(b) RETURN ...' \
    > /tmp/gitnexus.json
# OR
your-msp-script --gitnexus=stdio --output=/tmp/gitnexus.json

# 1b. Adapt the JSON shape to what sync.ts expects (nodes[] + edges[])
jq '.' < /tmp/gitnexus.json > /tmp/gitnexus-export.json

# 1c. Run the sync (everything else identical)
tsx examples/gitnexus-graph-cache/sync.ts \
    --export=/tmp/gitnexus-export.json \
    --graph=/path/to/.brain/msp/projects/<your-project>/graph/code.jsonl
```

The shape `sync.ts` accepts is documented inline at the top of the
file — keep it loose, add fields as your toolchain produces them.

## When NOT to use this pattern

Use direct GitNexus MCP calls (no caching) when:

- You always need fresh-as-of-this-second data (e.g. mid-refactor
  agent that just edited a function and wants the new call graph)
- Your codebase is small enough that GitNexus answers `impact` in
  < 50 ms anyway — no point caching
- You only ever ask one-shot questions; building a sync pipeline
  isn't worth it

Use this cache when:

- Many reads, infrequent writes (typical agent workload)
- You want bi-temporal queries ("what did the graph look like before
  PR #42 merged?")
- You want the read path to keep working when GitNexus is down
- You want the audit trail GKS already provides applied to code edges
  (every read gets logged + namespace-scoped)

## See also

- [ADR-008](../../docs/adr/008-gks-storage-engine-scope.md) — GKS
  scope; why GKS doesn't bake in code intelligence
- [ADR-009](../../docs/adr/009-msp-as-orchestrator.md) — peer
  subsystems; why this script lives outside `src/`
- [`docs/MSP_RELATIONSHIP.md`](../../docs/MSP_RELATIONSHIP.md#coexisting-with-peer-subsystems-eg-gitnexus)
  — narrative for the orchestrator pattern
- [`examples/memory-os-architecture/`](../memory-os-architecture/) —
  the Memory OS layer that would typically own this sync
