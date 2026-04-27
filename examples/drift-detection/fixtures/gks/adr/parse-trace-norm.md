---
id: ADR--PARSE-TRACE-NORM
phase: 2
type: adr
status: stable
vault_id: EXAMPLE
title: Parse-trace turn-tag normalization
linked_symbols:
  - { file: "src/memory/consolidator-llm.ts", fn: formatStep, line: 248 }
  - { file: "src/memory/consolidator-llm.ts", fn: validateExtractorOutput }
---

# ADR — Parse-trace turn-tag normalization

Normalize spoofed `[USER]` / `[AGENT]` tags before LLM consolidation.
Editing the governing functions without reviewing this ADR risks
re-introducing the security vector this decision closed.
