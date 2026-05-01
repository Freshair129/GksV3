---
id: FEAT--SUMMARY-TLDR
phase: 2
type: feat
status: stable
vault_id: default
title: FEAT — Pre-computed atom TL;DR summary field
crosslinks: {"parent_concept":["CONCEPT--SUMMARY-TLDR"],"parent_adr":["ADR--SUMMARY-TLDR"],"parent_blueprint":["BLUEPRINT--SUMMARY-TLDR"]}
linked_symbols:
  - {"file":"src/memory/types.ts","fn":"AtomicEntry"}
  - {"file":"src/memory/gks.ts","fn":"AtomicLayer"}
  - {"file":"src/memory/api.ts","fn":"retain"}
  - {"file":"src/memory/inbound.ts","fn":"InboundQueue.promote"}
  - {"file":"src/memory/tldr.ts"}
created_at: 2026-05-01T10:18:28.639Z
---

# FEAT — Pre-computed atom TL;DR summary field

## User-facing behaviour

**Author flow**

> Given an inbound atom in `.brain/.../inbound/`,
> when the user runs `gks inbound promote <id> --generate-tldr`,
> then GKS calls the configured LLM client once, generates a ≤200-token
> summary of the atom body, and writes it to the promoted file's
> frontmatter as `summary_tldr` along with `summary_tldr_body_hash` and
> `summary_tldr_generated_at`.

> Given a developer calling `MemoryStore.retain(content, { generateTldr: true })`,
> when the call completes,
> then the resulting atom (or vector doc metadata) carries a populated
> `summary_tldr` field generated from the content body.

**Reader flow**

> Given an agent calling `recall("query")`,
> when a hit's atom carries a `summary_tldr` field,
> then `hit.snippet` returns the TL;DR (capped by `snippetMaxChars` if
> set) instead of the 240-char body excerpt.

> Given an agent calling `recall("query")`,
> when a hit's atom does NOT carry a `summary_tldr` field,
> then `hit.snippet` falls back to the existing behaviour
> (body excerpt or title-only based on `snippetMaxChars`).

**Maintenance flow**

> Given an atom whose body has been edited after `summary_tldr` was
> generated,
> when the user runs `gks validate --tldr-staleness`,
> then GKS reports the atom by id with a warning, exits non-zero in CI
> mode, and the recall path continues to use the (now-stale) TL;DR
> until regenerated.

## Acceptance criteria

- [ ] **AC1**: New optional fields `summary_tldr`, `summary_tldr_body_hash`,
      `summary_tldr_generated_at` exist on `AtomicEntry`, `AtomicNote`,
      and round-trip through `atomic_index.jsonl`.
- [ ] **AC2**: `src/memory/tldr.ts` exports `TldrGenerator` interface,
      `createLlmTldrGenerator(opts)` (LLM-backed, reusing `LlmClient`
      from PR #25), and `heuristicTldrGenerator()` (deterministic fallback).
- [ ] **AC3**: `MemoryStore.retain(input)` accepts `generateTldr?: boolean`
      and `tldrGenerator?: TldrGenerator`; when `generateTldr: true` and
      no generator is supplied, the heuristic fallback is used (no API
      call, no crash).
- [ ] **AC4**: `gks inbound promote <id> --generate-tldr` calls the
      configured generator once and stamps frontmatter fields into the
      promoted file under `gks/<type>/`.
- [ ] **AC5**: `recall()` returns `summary_tldr` as the snippet when
      present; falls back to current behaviour when absent. No behavioural
      change for any existing atom in the repo's `gks/` tree.
- [ ] **AC6**: `recall(query, { snippetMaxChars: 80 })` against an atom
      with a 200-char `summary_tldr` truncates to 80 chars (with `…`),
      confirming PR #25's snippet cap still wins.
- [ ] **AC7**: `gks validate --tldr-staleness` walks every atom,
      recomputes body hash, and exits non-zero (warn) when any atom's
      `summary_tldr_body_hash` does not match its current body.
- [ ] **AC8**: All seven verification scenarios from
      [[BLUEPRINT--SUMMARY-TLDR]] (`V1` through `V7`) ship as automated
      tests in `test/memory/tldr.test.ts` and the relevant existing
      test files. Total test count strictly increases; no existing test
      regresses.
- [ ] **AC9**: `manifest.schema_version` minor-bumped; old vector stores
      load with a warning per the schema-version policy. Existing
      atoms in the repo's `gks/` tree pass `gks validate --links` after
      the change.
- [ ] **AC10**: Documentation updated in `docs/WORKFLOW.md` (when to
      use `--generate-tldr`), `README.md` backends table (TLDR row),
      and `CHANGELOG.md`.

## Out of scope

- Automatic regeneration on body edit (would require a file watcher /
  pre-commit hook — separate proposal).
- Multi-language TL;DRs (start English-only; Thai/multilingual is a
  follow-up if local-SLM support proves out).
- TL;DRs for Episodic memories (already have a `summary` field).
- Higher-order GraphRAG-style "summarize a community of atoms"
  (separate concept; this proposal is the prerequisite).
