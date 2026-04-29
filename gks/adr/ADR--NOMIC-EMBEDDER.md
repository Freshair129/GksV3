---
id: ADR--NOMIC-EMBEDDER
title: Use nomic-embed-text-v1.5 as the local embedding backend
status: accepted
created: 2026-04-29
links:
  - CONCEPT--EMBEDDING-STRATEGY
  - BLUEPRINT--NOMIC-EMBEDDER
---

## Decision

Use `nomic-ai/nomic-embed-text-v1.5` via `@huggingface/transformers` as
GKS's primary local embedder, replacing the Ollama fallback.

## Considered Alternatives

| Model | Dim | Thai | Tokens | Size | Rejected because |
|---|---|---|---|---|---|
| `TaylorAI/bge-micro-v2` | 384 | ❌ | 512 | 23MB | English-only |
| `intfloat/multilingual-e5-small` | 384 | ✅ | 512 | 120MB | 512 token limit too short |
| `intfloat/multilingual-e5-base` | 768 | ✅ | 512 | 440MB | Not in SC list |
| `nomic-ai/nomic-embed-text-v1.5` | 768 | ✅ | 2048 | ~550MB | **Selected** |
| `BAAI/bge-m3` | 1024 | ✅ | 8192 | 2.2GB | Too large for default |

## Rationale

**nomic-embed-text-v1.5** wins on all criteria:
- 768-dim: better recall quality than 384-dim for mixed-language content
- 2048 token context: handles full Obsidian notes without truncation
- Already listed in Smart Connections supported models → user can switch
  SC to the same model → GKS and SC vectors become compatible
- Runs fully local via ONNX, no Ollama required
- ~550MB downloaded once and cached by HuggingFace locally

## Prefix Requirement

nomic uses task-specific prefixes that must be applied consistently:
```
embedding a document → prepend "search_document: "
embedding a query   → prepend "search_query: "
```
Without consistent prefixes, cosine similarity scores are unreliable.
The GKS embedder must handle this internally — callers do not prepend prefixes.

## Consequences

- `@huggingface/transformers` added as a dependency (~15MB package, model downloaded on first use)
- First embed call takes 10–30s to download and load the model (cached after)
- Existing JSONL vector stores embedded with a different model become incompatible
  → users must re-embed with `npm run re-embed` after switching
- SC users should change their SC model setting to `Nomic-embed-text-v1.5`
  for vector-space compatibility (optional, not required)

## Updated Embedder Priority Chain

```
1. nomic (local, @huggingface/transformers) ← new default
2. Ollama (local server, if running)
3. OpenAI (cloud, if OPENAI_API_KEY set)
4. Mock (random vectors, tests only)
```
