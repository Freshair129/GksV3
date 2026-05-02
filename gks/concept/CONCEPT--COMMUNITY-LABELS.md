---
id: CONCEPT--COMMUNITY-LABELS
phase: 1
type: concept
status: stable
vault_id: default
title: CONCEPT — LLM-labelled communities
crosslinks: {"references":["CONCEPT--MEMORY-STORE"]}
created_at: 2026-05-02T09:29:46.378Z
---

# CONCEPT — LLM-labelled communities

## Problem

`detectCommunities()` returns clusters with `community_id = lex-smallest
member id`. That's stable but not human-friendly:

```
• ADR--FOO  size=4  members: [ADR--FOO, BLUEPRINT--FOO, FEAT--FOO, CONCEPT--FOO]
• ADR--BAR  size=3  members: [ADR--BAR, BLUEPRINT--BAR, FEAT--BAR]
```

A reader still has to open each member to figure out what the cluster
*is about*. For overview / navigation use cases ("show me the topic
clusters in this knowledge base") that's the wrong granularity.

ADR--AUTO-COMMUNITIES explicitly deferred this:
> Community labelling / naming via LLM (callers can chain
> summarizeCommunity for that). [out of scope]

But chaining `summarizeCommunity` per cluster gives a 200-token
narrative — too long for a label. We want a 1–4 word topic name.

## Hypothesis

If `detectCommunities()` accepts `withLabels: true | { generator }` and
returns each cluster with a `label` string (≤4 words), then:

- The output table becomes self-explanatory: `local-first profile`,
  `doc-to-code enforcement`, `episodic memory v2`, etc.
- The label fits in a CLI/UI listing without truncation.
- `gks community detect` becomes useful for **discovery** workflows
  ("what's in this knowledge base?") not just maintenance.

The cost per call: one LLM invocation per cluster (or one batched
call with all clusters in the prompt — TBD in the BLUEPRINT). With
member TLDRs already populated, the prompt is small (~50 tokens/member,
~5 members/cluster average → ~250 tokens). Heuristic fallback: take
the most-common stem from member ids (e.g., "summary-tldr",
"community-summaries").
