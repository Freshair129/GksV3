---
id: BLUEPRINT--NOMIC-EMBEDDER
title: Implementation plan for nomic-embed-text-v1.5 embedder
status: draft
created: 2026-04-29
links:
  - CONCEPT--EMBEDDING-STRATEGY
  - ADR--NOMIC-EMBEDDER
---

## Scope

Add `createNomicEmbedder()` to GKS and wire it as the first entry in the
embedder priority chain. No changes to vector store backends, retrieval
logic, or public API.

## Files to Change

| File | Change |
|---|---|
| `package.json` | add `@huggingface/transformers` to dependencies |
| `src/memory/vector/embedder-nomic.ts` | new file — NomicEmbedder implementation |
| `src/memory/vector/embedder.ts` | insert nomic at top of `createEmbedder()` chain |
| `src/memory/index.ts` | export `createNomicEmbedder` |

## embedder-nomic.ts — Shape

```ts
import type { Embedder } from './embedder.js'

export interface NomicEmbedderOptions {
  model?: string        // default: 'nomic-ai/nomic-embed-text-v1.5'
  dtype?: string        // default: 'fp32' (use 'q8' to halve RAM)
}

export function createNomicEmbedder(opts?: NomicEmbedderOptions): Embedder
```

### Internals

1. Lazy-load `@huggingface/transformers` on first call (dynamic import)
2. Load pipeline once, reuse across calls (singleton pattern)
3. Prepend prefixes before passing to pipeline:
   - `isQuery=true`  → `"search_query: " + text`
   - `isQuery=false` → `"search_document: " + text`
4. Pool with `mean`, normalize output to unit vector
5. Return `number[]` of length 768

### Embedder interface contract

```ts
interface Embedder {
  embed(text: string, opts?: { isQuery?: boolean }): Promise<number[]>
  embedBatch(texts: string[], opts?: { isQuery?: boolean }): Promise<number[][]>
  readonly dims: number   // 768
  readonly name: string   // 'nomic'
}
```

## createEmbedder() — Updated Chain

```ts
// src/memory/vector/embedder.ts
export async function createEmbedder(opts: EmbedderOptions): Promise<Embedder> {
  // 1. Explicit override
  if (opts.embedder) return opts.embedder

  // 2. nomic (local, always available if package installed)
  if (!opts.skipNomic) {
    try {
      const e = createNomicEmbedder()
      await e.embed('ping', { isQuery: true })  // warm up + validate
      return e
    } catch { /* fall through */ }
  }

  // 3. Ollama
  if (await ollamaAvailable()) return createOllamaEmbedder(opts)

  // 4. OpenAI
  if (process.env.OPENAI_API_KEY) return createOpenAIEmbedder(opts)

  // 5. Mock
  return mockEmbedder(768)
}
```

## Re-embed Script

`npm run re-embed` must be run after switching embedders to rebuild all
existing JSONL vector stores. The script is already at
`scripts/msp/re-embed.ts` — no changes needed, it calls `embedder.embedBatch()`
which will pick up the new nomic embedder automatically.

## Testing

- Unit: `test/memory/vector/embedder-nomic.test.ts`
  - embed a Thai string → returns 768-dim vector
  - embed a query vs document → different vectors (prefix working)
  - same text embedded twice → identical output (deterministic)
- Skip if `@huggingface/transformers` not available (like hnswlib pattern)

## Decisions

- [x] **fp32** — full precision, no quality trade-off
- [x] **Show progress on first download** — log to stderr with percentage
- [x] **Model fixed** — `nomic-ai/nomic-embed-text-v1.5` not configurable, keeps API simple
