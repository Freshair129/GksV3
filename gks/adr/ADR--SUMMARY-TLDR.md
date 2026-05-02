---
id: ADR--SUMMARY-TLDR
phase: 2
type: adr
status: stable
vault_id: default
title: ADR — Pre-computed atom TL;DR summary field
crosslinks: {"parent_concept":["CONCEPT--SUMMARY-TLDR"],"references":["ADR--FLAT-ATOM-LAYOUT","ADR--EXTENDED-TAXONOMY"]}
created_at: 2026-05-01T10:18:25.820Z
---

# ADR — Pre-computed atom TL;DR summary field

## Context

GKS atoms today carry a free-form markdown body (typical 2–5 KB) plus
structured frontmatter (id, phase, type, status, crosslinks,
linked_symbols). `recall()` returns either a 240-char body excerpt or
the title only; neither is a calibrated summary of what the atom *says*.

Per [[CONCEPT--SUMMARY-TLDR]], adding a pre-computed TL;DR field would
let recall return a dense, informative snippet at the same token budget,
cutting downstream `lookup(id)` follow-ups and improving the
read-amplification ratio that dominates agent token spend.

The decision is *not* whether to add a summary capability — that's
already implicit in many similar systems (Mem0, GraphRAG, Letta). The
decision is **where the summary lives** and **when it gets generated**.

## Decision

Add an **optional** `summary_tldr: string | undefined` field to
`AtomicEntry`, `AtomicNote`, and the corresponding `atomic_index.jsonl`
row. Generation is opt-in via two pathways:

1. **At promote time** (`gks inbound promote`): if the consolidator LLM
   is configured (Anthropic or local SLM via the
   `createOpenAICompatibleClient` added in PR #25), generate a TL;DR
   from the atom body and stamp it into the frontmatter before writing
   to `gks/<type>/`.
2. **At retain time** (`MemoryStore.retain()`): if `opts.generateTldr`
   is true and an LLM client is supplied, generate before writing.

Recall returns `summary_tldr` (when present) as the snippet. Existing
behaviour (body excerpt or title-only) is preserved as fallback when
`summary_tldr` is absent — every atom in the current tree continues to
work without rewriting.

The field is **frontmatter, not body**, because:
- It must survive index rebuilds (`npm run msp:index`)
- It is queryable / filterable like other frontmatter
- It is small enough (≤200 tokens, ~600 chars) not to bloat the index

## Consequences

**Positive:**
- Recall snippets become semantically dense; agents need fewer
  follow-up `lookup(id)` calls. Estimated 50%+ reduction in atom-body
  reads on relevance-decision-heavy workloads.
- Zero migration cost — existing atoms keep working; field is optional.
- Composes with `snippetMaxChars` from PR #25:
  `snippetMaxChars=summary_tldr.length` becomes the natural default once
  TL;DRs are populated.
- Foundation for higher-order GraphRAG-style community summaries
  (summarize-the-summaries pattern).

**Negative:**
- One LLM call per promote/retain (latency + token spend). Mitigated by:
  (a) opt-in only, (b) local SLM path costs $0, (c) cached forever once
  generated.
- Field can drift from body if the body is edited and TL;DR isn't
  regenerated. Mitigated by `gks validate --tldr-staleness` (future
  CLI subcommand to flag drift via body hash comparison).
- Adds a soft dependency on an LLM client at promote time. Mitigated by
  the heuristic-extractor fallback already in `consolidator.ts` (first
  N sentences of body).

**Schema migration:**
- Add `summary_tldr?: string` to `AtomicEntry` and `AtomicNote` in
  `src/memory/types.ts`.
- Add `summary_tldr_generated_at?: string` and
  `summary_tldr_body_hash?: string` for staleness tracking.
- `manifest.schema_version` minor-bump (additive change, old stores load
  with a warning per the schema-version policy).

## Alternatives considered

1. **Generate TL;DR at recall time, on the fly.** — *rejected.* Pushes
   LLM cost onto the read path (the hot path), defeats the whole
   purpose. Latency would also be unacceptable for interactive use.

2. **Store TL;DR as a sibling file `<id>.tldr.md`.** — *rejected.*
   Doubles the file count, complicates `gks/<type>/` layout, and breaks
   the single-source-of-truth principle from
   [[ADR--FLAT-ATOM-LAYOUT]]. Frontmatter is the right home.

3. **Make TL;DR mandatory.** — *rejected.* Forces every consumer to
   either provide an LLM or run heuristics, which would block adoption
   in environments without API access. Optional + fallback is the
   compatible path.

4. **Use vector store text as the "summary."** — *rejected.* Vector
   text is the body chunk for embedding, not a summary. Different
   semantics; conflating them would surprise advanced users who tune
   chunking strategies.

5. **Reuse the existing `EpisodicMemory.summary` field.** — *rejected.*
   That summarises a *session*, not an atom. Different lifecycles,
   different scopes — coupling them would be a concern overlap that
   leaks back into the four-layer model from
   [[FRAME--FOUR-LAYERS]].
