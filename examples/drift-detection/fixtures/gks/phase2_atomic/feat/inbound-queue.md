---
id: FEAT--INBOUND-QUEUE
phase: 2
type: feat
status: stable
vault_id: EXAMPLE
title: Inbound queue
linked_symbols:
  - { file: "src/memory/inbound.ts", fn: propose }
  - { file: "src/memory/inbound.ts", fn: renderArtifactMarkdown }
---

# FEAT — Inbound queue

The only authorized write path to atoms destined for `gks/`.
