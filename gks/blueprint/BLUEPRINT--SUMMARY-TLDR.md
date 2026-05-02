---
id: BLUEPRINT--SUMMARY-TLDR
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Pre-computed atom TL;DR summary field
crosslinks: {"parent_adr":["ADR--SUMMARY-TLDR"],"parent_concept":["CONCEPT--SUMMARY-TLDR"]}
linked_symbols:
  - {"file":"src/memory/types.ts","fn":"AtomicEntry"}
  - {"file":"src/memory/types.ts","fn":"AtomicNote"}
  - {"file":"src/memory/gks.ts","fn":"AtomicLayer"}
  - {"file":"src/memory/api.ts","fn":"retain"}
  - {"file":"src/memory/index.ts","fn":"vectorHitToRetrieval"}
  - {"file":"src/memory/inbound.ts","fn":"InboundQueue.promote"}
  - {"file":"src/memory/consolidator-llm.ts","fn":"createOpenAICompatibleClient"}
created_at: 2026-05-01T10:18:27.103Z
---

# BLUEPRINT — Pre-computed atom TL;DR summary field

```yaml
metadata:
  title: "Pre-computed atom TL;DR summary field"
  status: draft

architectural_pattern: |
  Optional frontmatter field generated lazily by an injected LLM client at
  promote/retain time. Cached forever; staleness tracked via body hash.
  Recall reads it as the snippet when present, falls back to existing
  body-excerpt or title-only behaviour when absent.

data_logic: |
  Write path:
    1. retain() / inbound.promote() finishes its existing work.
    2. If a TldrGenerator is configured AND opts.generateTldr is true:
       a. Hash the body (SHA-256, first 16 hex chars).
       b. Call generator.summarize(body) → returns ≤200-token summary.
       c. Stamp summary_tldr, summary_tldr_body_hash,
          summary_tldr_generated_at into the frontmatter.
    3. Index rebuild (msp:index) carries the new fields into
       atomic_index.jsonl.

  Read path:
    1. retrieve() runs as today (atomic + vector + episodic + obsidian).
    2. vectorHitToRetrieval() / atomicHitToRetrieval() check
       metadata.summary_tldr; if present, use it as snippet (capped by
       opts.snippetMaxChars).
    3. If absent, fall back to current logic (240-char body excerpt or
       title-only depending on snippetMaxChars).

  Drift detection:
    A new CLI subcommand `gks validate --tldr-staleness` walks every
    atom, recomputes body hash, compares to summary_tldr_body_hash, and
    reports atoms whose summary may be stale. Non-blocking warning.

geography:
  - "src/memory/types.ts"                 # add summary_tldr fields
  - "src/memory/gks.ts"                   # AtomicLayer reads new fields
  - "src/memory/api.ts"                   # retain() opt-in TLDR generation
  - "src/memory/inbound.ts"               # promote() opt-in TLDR generation
  - "src/memory/index.ts"                 # vectorHitToRetrieval uses TLDR
  - "src/memory/tldr.ts"                  # NEW: TldrGenerator interface +
                                          #   default LLM-backed impl
  - "src/memory/consolidator-llm.ts"      # reuse LlmClient interface
  - "scripts/atomic-index.ts"             # carry TLDR into index.jsonl
  - "test/memory/tldr.test.ts"            # NEW: TldrGenerator unit tests
  - "test/memory/api.test.ts"             # retain() with generateTldr
  - "test/memory/inbound-promote.test.ts" # promote() with generateTldr
  - "test/memory/memory-store.test.ts"    # snippet falls back to TLDR

api_contracts:
  - name: "TldrGenerator"
    file: "src/memory/tldr.ts"
    shape: |
      interface TldrGenerator {
        readonly name: string
        summarize(body: string, opts?: {
          maxTokens?: number   // default 200
          context?: string     // optional atom title/type for prompt
        }): Promise<string>
      }

      function createLlmTldrGenerator(opts: {
        client: LlmClient        // reuse from consolidator-llm.ts
        maxTokens?: number       // default 200
        fallback?: TldrGenerator // default heuristicTldrGenerator
      }): TldrGenerator

      function heuristicTldrGenerator(): TldrGenerator
        // first 2-3 sentences after the H1, deterministic, zero LLM cost

  - name: "AtomicEntry frontmatter additions"
    file: "src/memory/types.ts"
    shape: |
      interface AtomicEntry {
        // ... existing fields ...
        summary_tldr?: string                 // ≤200 token summary
        summary_tldr_body_hash?: string       // SHA-256 first 16 hex
        summary_tldr_generated_at?: string    // ISO-8601
      }

  - name: "RetainInput / InboundPromoteOpts additions"
    file: "src/memory/types.ts"
    shape: |
      interface RetainInput {
        // ... existing fields ...
        generateTldr?: boolean                // default false
        tldrGenerator?: TldrGenerator         // injected; falls back to
                                              // heuristic if omitted
      }

verification_plan:
  - id: V1-tldr-roundtrip
    description: |
      retain() with generateTldr:true populates summary_tldr; recall()
      returns summary_tldr as snippet; lookup() shows full body unchanged.
  - id: V2-tldr-fallback-when-absent
    description: |
      retrieve() against a fixture with no summary_tldr falls back to
      the current 240-char body excerpt. No regression for existing atoms.
  - id: V3-tldr-staleness-detection
    description: |
      Edit the body of an atom that has summary_tldr; run
      `gks validate --tldr-staleness`; expect it reports the atom with
      a non-zero exit code (warn-only, not error).
  - id: V4-tldr-heuristic-fallback
    description: |
      retain() with generateTldr:true but no LLM client falls through to
      heuristicTldrGenerator (first N sentences). No crash, no API call.
  - id: V5-tldr-respects-snippet-cap
    description: |
      recall() with snippetMaxChars=80 against an atom whose summary_tldr
      is 200 chars truncates to 80 chars (with ellipsis), confirming the
      snippetMaxChars option from PR #25 still wins.
  - id: V6-promote-generates-tldr
    description: |
      `gks inbound promote --generate-tldr` on an inbound atom calls the
      configured LLM client once and stamps the result into
      gks/<type>/<id>.md frontmatter.
  - id: V7-index-carries-tldr
    description: |
      `npm run msp:index` reads summary_tldr from frontmatter and
      includes it in atomic_index.jsonl rows. Verified by inspecting
      the JSONL file after a fixture promote.

implementation_steps:
  - 1. Land types: add three optional fields to AtomicEntry/AtomicNote +
       update the atomic-index reader/writer to carry them.
  - 2. Build src/memory/tldr.ts: TldrGenerator interface, LLM-backed
       impl (reuses LlmClient from PR #25), heuristic fallback.
  - 3. Wire opt-in into retain() and InboundQueue.promote().
  - 4. Add `--generate-tldr` flag to `gks inbound promote` CLI.
  - 5. Update vectorHitToRetrieval / atomicHitToRetrieval to prefer
       summary_tldr when present (still respecting snippetMaxChars cap).
  - 6. Add `gks validate --tldr-staleness` subcommand (body hash check).
  - 7. Tests for V1-V7. Bump manifest.schema_version (minor).
  - 8. Document in docs/WORKFLOW.md and the README backends table.
```
