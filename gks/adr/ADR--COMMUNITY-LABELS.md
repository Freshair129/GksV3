---
id: ADR--COMMUNITY-LABELS
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — LLM-labelled communities
crosslinks: {"parent_concept":["CONCEPT--COMMUNITY-LABELS"],"references":["ADR--AUTO-COMMUNITIES","ADR--SUMMARY-TLDR"]}
created_at: 2026-05-02T09:29:47.575Z
---

# ADR — LLM-labelled communities

## Context

[[CONCEPT--COMMUNITY-LABELS]] motivates adding 1–4 word topic names to
`DetectedCommunity[]`. Open questions:

1. **One LLM call per cluster, or one batched call?**
2. **Default behaviour: auto-label or opt-in?**
3. **Heuristic fallback shape?**

## Decision

### 1. Per-cluster LLM call (sequential), with optional batch

Default: one `TldrGenerator.summarize` call per cluster, max-tokens=24
(a 4-word label is well under that). Sequential rather than batched
because:
- Each cluster is small (5 members × 200-token TLDRs ≈ 1K tokens) —
  parallel/batch gain is marginal at single-digit cluster counts.
- Failures isolate per cluster; one bad cluster doesn't poison the
  rest.
- Reuses the existing TldrGenerator interface — no new prompt shape.

Future optimisation if cluster count grows: a `batchedLabel(clusters,
generator)` helper that sends them all in one prompt. Out of scope here.

### 2. Opt-in via `withLabels`

`detectCommunities(opts.withLabels)` is opt-in. Default behaviour
(no field) stays byte-identical so existing callers see no change.
Three forms accepted:

```ts
withLabels?: boolean | { generator?: TldrGenerator }
```

- `false` / undefined → no labels (default)
- `true` → use the heuristic fallback (deterministic, zero LLM cost)
- `{ generator }` → use the supplied LlmTldrGenerator (or any
  TldrGenerator); falls through to heuristic on error

Per-call: when `withLabels` is set, `detectCommunities` becomes
`async`. (It's already async via `MemoryStore.detectCommunities`; the
pure function picks up an async path only when labels are requested.)

### 3. Heuristic fallback: longest common stem

When no LLM is available (or `withLabels: true`), produce a label
from member ids by:
1. Splitting each member id on `--` and `-`
2. Keeping tokens that appear in ≥ ⌈size/2⌉ members
3. Joining the survivors lower-case-kebab

For the chain `[CONCEPT--SUMMARY-TLDR, ADR--SUMMARY-TLDR,
BLUEPRINT--SUMMARY-TLDR, FEAT--SUMMARY-TLDR]`, output:
`summary-tldr`. Deterministic; offline-safe; usually meaningful.

When the heuristic produces an empty label, fall back to the
`community_id`.

### 4. Result shape

```ts
interface DetectedCommunity {
  // existing
  community_id: string
  members: string[]
  size: number
  density: number
  // NEW (optional)
  label?: string
  labelSource?: 'llm' | 'heuristic' | 'fallback'
}
```

`labelSource` lets callers tell at a glance whether to trust the
phrasing (LLM) vs the bag-of-words approximation (heuristic).

## Consequences

**Positive:**
- Detection results become readable without opening every member.
- `gks community detect` produces a usable overview of the knowledge
  base.
- Composes with existing local-SLM TldrGenerator — labels can run
  offline at zero marginal cost.

**Negative:**
- Labelling adds N LLM calls per detect (where N = cluster count).
  Mitigated by heuristic fallback + opt-in default.
- Heuristic labels can be inelegant ("doc-to-code-enforcement" vs the
  LLM's "Doc-to-code"). Acceptable for the tier they target.
- Adds an async path through what was previously a sync function.
  Mitigated by keeping it opt-in.

**Schema impact:** none on disk. New optional field on the in-memory
result.

## Alternatives considered

1. **Always run heuristic; LLM never.** *Rejected.* Heuristic is good
   but not great; the LLM path is cheap when an LLM is configured.

2. **Persist labels to a sidecar `.brain/<ns>/community-labels.json`.**
   *Rejected.* Communities depend on `opts` (edgeKeys, minSize), so
   one canonical persisted set would be wrong for half the callers.
   Pair with PERSISTED-COMMUNITY-SUMMARIES if read amplification
   warrants it.

3. **Use the FIRST member's title as the label.** *Rejected.* Often
   wrong — phase-asc-id-asc sorts can put a CONCEPT first, but the
   cluster might be best labelled by the FEAT.

4. **Embed cluster TLDRs and cluster their semantic centroid as the
   label.** *Rejected.* Over-engineered. A 24-token LLM call solves
   it directly.
