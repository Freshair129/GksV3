---
id: CONCEPT--EMBEDDING-STRATEGY
title: Multilingual Embedding Strategy for Thai+English Content
status: stable
created: 2026-04-29
links:
  - ADR--NOMIC-EMBEDDER
  - BLUEPRINT--NOMIC-EMBEDDER
---

## Context

GKS users write in Thai and English mixed together. The default embedder
fallback chain (Ollama → OpenAI → Mock) does not guarantee Thai support,
and the mock produces random vectors useless for real recall.

Smart Connections (Obsidian plugin) runs embeddings locally via
`@huggingface/transformers`. If GKS uses the same model, vectors from
both systems occupy the same semantic space — enabling cross-search
without duplication.

## Problem

| Issue | Impact |
|---|---|
| `bge-micro-v2` (SC default) trained on English | Thai queries return wrong results |
| Ollama required for local embedding | Extra process to install and run |
| GKS and SC use different models | Cannot cross-search vault + memory |
| OpenAI fallback sends data to cloud | Privacy concern for personal notes |

## Solution Space

Run a multilingual embedding model directly inside the GKS process via
`@huggingface/transformers` — no separate server, no cloud, no SC dependency.

Model choice criteria:
1. Thai + English quality
2. Runs via ONNX (no Python, no GPU required)
3. Already in Smart Connections model list (for future vector compatibility)
4. Context window ≥ 1024 tokens (Obsidian notes can be long)
5. Size reasonable for a dev machine (< 1GB)

## Key Insight

`@huggingface/transformers` is a standalone npm package. Smart Connections
uses it internally, but GKS using it does NOT create a dependency on SC.
If both choose the same model, their vectors happen to be compatible — that
is a benefit, not a coupling.
