---
id: FEAT--COMMUNITY-LABELS
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — LLM-labelled communities
crosslinks: {"parent_concept":["CONCEPT--COMMUNITY-LABELS"],"parent_adr":["ADR--COMMUNITY-LABELS"],"parent_blueprint":["BLUEPRINT--COMMUNITY-LABELS"]}
linked_symbols:
  - {"file":"src/memory/community-detect.ts"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.detectCommunities"}
  - {"file":"bin/gks.ts","fn":"cmdCommunityDetect"}
created_at: 2026-05-02T09:29:49.986Z
---

# FEAT — LLM-labelled communities

## User-facing behaviour

> Given a developer who wants a topic name per detected community,
> when they call `store.detectCommunities({ withLabels: true })`,
> then each community in the result carries `label` (heuristic stem
> from member ids) and `labelSource: 'heuristic'`.

> Given a developer with an LLM client configured,
> when they call `store.detectCommunities({ withLabels: { generator } })`,
> then each cluster's `label` is the LLM's 1–4 word topic name and
> `labelSource: 'llm'`.

> Given the CLI: `gks community detect --labels`,
> when env GKS_LLM_BASE_URL or ANTHROPIC_API_KEY is set,
> then the LLM is used; otherwise the heuristic fallback runs.

## Acceptance criteria

- [ ] **AC1**: `DetectCommunitiesOptions.withLabels` accepts
      `boolean | { generator?: TldrGenerator }` per BLUEPRINT.
- [ ] **AC2**: `DetectedCommunity` gains optional `label` and
      `labelSource: 'llm' | 'heuristic' | 'fallback'`. Both are
      undefined when `withLabels` was not requested.
- [ ] **AC3**: Default behaviour (no `withLabels`) is byte-identical to
      the pre-change implementation.
- [ ] **AC4**: `withLabels: true` runs the heuristic; `labelSource: 'heuristic'`.
- [ ] **AC5**: `withLabels: { generator }` runs the LLM; on success
      `labelSource: 'llm'`. On error/empty output, falls back to
      heuristic; on empty heuristic too, uses `community_id` and
      `labelSource: 'fallback'`.
- [ ] **AC6**: Heuristic extracts the longest common stem from member
      ids (tokens appearing in ≥ ⌈size/2⌉ members), kebab-cased, lower.
- [ ] **AC7**: `gks community detect --labels` CLI flag selects
      generator via the same env precedence as `tldr regenerate`.
      Output shows the label inline: `• <community_id>  "<label>"  size=N density=D`.
- [ ] **AC8**: `gks_community_detect` MCP tool accepts an optional
      `withLabels` argument matching the Node API shape.
- [ ] **AC9**: 7 verification scenarios from BLUEPRINT (V1-V7) ship
      as automated tests in `test/memory/community-detect.test.ts`.

## Out of scope

- Persisted labels (would couple to atom write path; pair with
  PERSISTED-COMMUNITY-SUMMARIES if read amplification justifies).
- Batched labelling (one prompt for N clusters) — defer until cluster
  counts grow past low double digits.
- Multilingual labels (let the LLM decide based on the prompt language;
  no per-locale plumbing).
- Persisting labelSource history / regen-on-demand for labels alone.
