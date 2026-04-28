# Drift detection

> The application of `lookupBySymbol` ([ADR-010](../../docs/adr/010-reverse-citation-lookup.md))
> + cached GitNexus call edges ([ADR-009](../../docs/adr/009-msp-as-orchestrator.md)
> peer pattern). Combines both into a single bidirectional drift check
> suitable for a pre-push hook.

```
git diff (or stdin) ─→ list of changed code paths
                         │
              ┌──────────┴───────────┐
              ▼                      ▼
      gks.lookupBySymbol      graph.neighbors
      (which atoms cite       (which code is
      this code path?)        downstream of it?)
              │                      │
              └──────────┬───────────┘
                         ▼
            risk-classified report
            HIGH / MEDIUM / LOW / NONE
                         │
                         ▼
                exit 1 if HIGH+MEDIUM,
                otherwise exit 0
```

## Why

`lookupBySymbol` (3.5.2) and the re-indexer (3.5.3) gave us forward
citations atom → code and reverse queries code → atom. But the
*application* — "I edited a function; did I just contradict an ADR? does
that change have downstream callers I forgot?" — wasn't shown.

This example fills that gap. It's the recipe an MSP-style orchestrator
would wire into a pre-push hook. GKS itself doesn't ship the hook (per
[ADR-008](../../docs/adr/008-gks-storage-engine-scope.md): workflow
gates live above the storage engine).

## Risk classification

| Risk | Citing atom types | Behaviour |
|---|---|---|
| **HIGH** | `adr`, `blueprint` | Exit 1 — review the governing decision before pushing. |
| **MEDIUM** | `feat`, `concept`, `flow` | Exit 1 — design doc may need updating. |
| **LOW** | `insight`, `fact`, `frame` | Exit 0 (informative) — surfaced in output but not blocking. |
| **NONE** | (none) | Exit 0. No atom cites this path. |

Conservative defaults: governance decisions (ADR / BLUEPRINT) block by
default; `--no-verify` is the explicit opt-out.

## Files

```
examples/drift-detection/
├── README.md                            # you are here
├── check-drift.ts                       # the orchestrator script
├── pre-push-hook.sh                     # example git hook (drift)
├── hotfix-gate.sh                       # example pre-commit hook (hotfix backfill, ADR-014)
├── smoke-test.ts                        # end-to-end (21 assertions)
└── fixtures/
    ├── gks/                             # 4 atoms with linked_symbols / geography
    │   ├── 00_index/atomic_index.jsonl  # pre-built so the demo runs offline
    │   └── phase{2,3}_*/                # source markdown
    └── code-graph.jsonl                 # sample GitNexus → GraphStore export
```

## End-to-end demo

```sh
# from this directory:

# 1. HIGH-risk path (ADR governs this fn) — exit 1
tsx check-drift.ts \
    --root=fixtures \
    --graph=fixtures/code-graph.jsonl \
    --paths=src/memory/consolidator-llm.ts:formatStep
# → ⚠ 1 path(s) need doc review before push (1 HIGH, 0 MEDIUM).
# → exit 1

# 2. LOW-risk path (only an INSIGHT cites it) — exit 0
tsx check-drift.ts \
    --root=fixtures \
    --graph=fixtures/code-graph.jsonl \
    --paths=src/lib/yaml-lite.ts:yamlScalar
# →   LOW     src/lib/yaml-lite.ts:yamlScalar
# →             ▸ INSIGHT--YAML-LITE                yamlLite escape rules
# →             ↑ called by: fn:src/lib/yaml-lite.ts:yamlLite, ...
# → ✓ no doc/code drift signals.
# → exit 0

# 3. stdin mode (what the pre-push hook uses)
echo "src/memory/consolidator-llm.ts:formatStep" \
  | tsx check-drift.ts --stdin --root=fixtures --graph=fixtures/code-graph.jsonl

# 4. JSON for CI / reviewers
tsx check-drift.ts \
    --root=fixtures \
    --graph=fixtures/code-graph.jsonl \
    --paths=src/memory/inbound.ts:propose,src/never.ts \
    --json
```

## Wiring as a pre-push hook

```sh
# Plain git hook
cp examples/drift-detection/pre-push-hook.sh .git/hooks/pre-push
chmod +x .git/hooks/pre-push

# Or via husky
npx husky add .husky/pre-push \
  "$(cat examples/drift-detection/pre-push-hook.sh)"
```

The hook:
1. Lists code paths changed since the upstream branch.
2. Pipes them into `check-drift.ts --stdin`.
3. Aborts the push (exit 1) if any HIGH or MEDIUM citations exist.

`git push --no-verify` overrides — appropriate for the rare case where
the developer has already updated the doc in the same PR but linked it
via a fresh atom that the local index doesn't yet reflect.

## Wiring real GitNexus data

The fixture `code-graph.jsonl` is a hand-crafted minimal graph. In a
real deployment, populate the same file via `examples/gitnexus-graph-cache/sync.ts`:

```sh
# 1. Sync GitNexus's AST into a GKS graph file (run on a cron / git-hook)
tsx examples/gitnexus-graph-cache/sync.ts \
    --graph=.brain/msp/projects/evaAI/graph/code.jsonl

# 2. Drift-check uses the same file
tsx examples/drift-detection/check-drift.ts \
    --graph=.brain/msp/projects/evaAI/graph/code.jsonl \
    --stdin < changed-paths.txt
```

Per [ADR-009](../../docs/adr/009-msp-as-orchestrator.md): GKS imports
nothing from GitNexus. The orchestrator (this script) reads from a
GraphStore that was *separately* populated by the gitnexus sync. GKS
treats the rows as ordinary data — it doesn't know they came from
GitNexus.

## What this example demonstrates

- **End-to-end use of `lookupBySymbol`** — the primitive shipped in
  3.5.2 finally has a concrete caller.
- **The Pattern 2 orchestration model from ADR-009** — script combines
  GKS + (cached) GitNexus answers without GKS depending on GitNexus.
- **Risk-aware drift gating** — not every citation should block; the
  type-based classification keeps the hook actionable.
- **stdin / JSON / exit-code contract** — designed for hook + CI use,
  not interactive only.

## Tests

```sh
tsx examples/drift-detection/smoke-test.ts
# → 21 assertions pass (HIGH / MEDIUM / LOW / NONE / JSON / stdin)
```

## See also

- [`examples/gitnexus-graph-cache/`](../gitnexus-graph-cache/) — populates
  the call-graph this example consumes
- [`examples/memory-os-architecture/`](../memory-os-architecture/) — Memory OS
  layering POC; this drift script would naturally live inside such an
  orchestrator
- [ADR-008](../../docs/adr/008-gks-storage-engine-scope.md) —
  drift-checking is the orchestrator's job, not GKS's
- [ADR-009](../../docs/adr/009-msp-as-orchestrator.md) — peer subsystem
  pattern (GKS + GitNexus, not GKS-over-GitNexus)
- [ADR-010](../../docs/adr/010-reverse-citation-lookup.md) — the
  primitive this script applies
