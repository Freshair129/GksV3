---
id: POC--<NAME>
phase: 1
type: poc
status: open                       # open | running | validated | invalidated | abandoned
vault_id: <YOUR-PROJECT>
title: <one-line summary of the hypothesis being tested>
hypothesis: |                      # REQUIRED — one paragraph, falsifiable
  <what we believe is true / will work>
acceptance_criteria:               # REQUIRED — measurable checks that prove or disprove
  - <criterion 1>
  - <criterion 2>
time_box:                          # REQUIRED — POCs must terminate
  opened_at: <ISO timestamp>
  deadline: <ISO timestamp>
  closed_at: null                  # filled when status leaves open/running
linked_symbols:                    # files / directories holding the experiment code
  - { file: examples/<name>/, fn: <entrypoint> }
crosslinks:
  derives_from: []                 # CONCEPT-- the hypothesis came from
  produces: []                     # BLUEPRINT-- / AUDIT-- the POC writes
  feeds_into: []                   # ADR-- the POC informs (filled after closure)
  references: []
---

# POC — <Title>

## Hypothesis

State the hypothesis as a single falsifiable claim. Examples:

- "GKS storage primitives are sufficient backing for a Memory OS without
  changes to retain/recall/reflect."
- "BM25 reranker recovers ≥80% of cross-encoder top-3 quality at 10x
  lower latency."
- "Migrating the JSONL vector store to HNSW reduces P99 recall latency
  below 50ms on the LongMemEval dataset."

## Acceptance criteria

What evidence — measurable, falsifiable — proves or disproves the
hypothesis. Examples:

- [ ] Memory OS runs end-to-end against `gks-mcp-server` for ≥10 minutes
      without crashes
- [ ] Recall@3 on LongMemEval ≥ 0.80 with BM25-only
- [ ] HNSW P99 latency < 50ms over 10k queries

## Time box

| Field | Value |
|---|---|
| Opened | `<ISO>` |
| Deadline | `<ISO>` |
| Closed | (filled at close) |
| Resolution | `validated` / `invalidated` / `abandoned` |

After `deadline` with no closure, the pre-commit hook blocks commits
that touch `linked_symbols` paths until `gks poc close <id>` is run.

## Method

Brief description of *how* the experiment is run — entrypoint script,
dataset, evaluation harness, expected duration. Keep this short; the
detailed plan goes in `BLUEPRINT--<NAME>` if one is created.

## Result

(Filled at closure.)

- **Status:** validated / invalidated / abandoned
- **Evidence:** <link to AUDIT-- / dataset / metrics>
- **Decision:** <link to ADR-- that builds on this outcome>
- **Notes:** <surprises, gotchas, follow-up questions>

## References

- Hypothesis source: `<CONCEPT--...>`
- Implementation plan (if promoted): `<BLUEPRINT--...>`
- Verification result (if produced): `<AUDIT--...>`
- Final decision: `<ADR--...>`
