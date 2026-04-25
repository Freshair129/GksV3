# GKS v3 — Benchmarks Guide

Three runners (LoCoMo, LongMemEval, BEAM) and a sweep orchestrator. All
backend-pluggable via CLI flags so you can mix-and-match embedder × reranker
× backend without code changes.

## Quick start (in-process, mock embedder)

The fastest sanity check. Uses the SHA-256 mock embedder and tiny fixtures
shipped in the repo. No network, no infra:

```sh
npm run bench:sweep -- --config=benchmarks/sweep.example.json
```

The sweep writes JSON + Markdown to `benchmarks/reports/sweep-<sha>-<ts>.{json,md}`.

## Real runs (the SOTA-claim path)

### Prereqs

| Component | Why | Setup |
|---|---|---|
| Postgres + pgvector | `--backend=pgvector` | `npm run pg:up && npm run pg-migrate` |
| HNSW (in-process) | `--backend=hnsw` | nothing — `hnswlib-node` ships prebuilt |
| Ollama with bge-m3 | `--provider=ollama` | `ollama pull bge-m3` |
| OpenAI fallback | `--provider=openai` | `OPENAI_API_KEY=sk-...` |
| BGE rerank-v2 (TEI) | `--rerank-endpoint=URL` | `npm run rerank:up` |
| Anthropic Sonnet 4.6 | LLM consolidator (out of bench scope) | `ANTHROPIC_API_KEY=sk-ant-...` |

### Single benchmark

```sh
# LoCoMo against the full HuggingFace dataset, bge-m3 + BGE rerank-v2 + HNSW:
LOCOMO_DATASET=/path/to/locomo10.json \
  npm run bench:locomo -- \
    --provider=ollama \
    --backend=hnsw \
    --rerank-endpoint=http://localhost:8080/rerank \
    --top-k=10 --threshold=0.3
```

### Sweep across the whole matrix

Edit a config (start from `benchmarks/sweep.example.json`):

```json
{
  "benchmarks": ["locomo", "longmemeval", "beam"],
  "backends":   ["pgvector", "hnsw"],
  "providers":  ["ollama"],
  "rerankers":  ["http"],
  "topK": 10,
  "threshold": 0.3,
  "perBench": {
    "locomo":      { "datasetPath": "/path/to/locomo10.json" },
    "longmemeval": { "datasetPath": "/path/to/longmemeval_s.json" }
  }
}
```

Then:

```sh
DATABASE_URL=postgres://gks:gks@localhost:5432/gks \
GKS_RERANK_ENDPOINT=http://localhost:8080/rerank \
  npm run bench:sweep -- --config=path/to/sweep.json
```

Output goes to `benchmarks/reports/sweep-<sha>-<ts>.{json,md}` with full
provenance (git SHA, dirty flag, Node version, platform, model versions).

## Targets (per ULTRAPLAN Phase 3)

| Benchmark | Metric | Target | Notes |
|---|---|---|---|
| **LoCoMo** | evidence@5 | **≥ 92%** | bge-m3 + BGE rerank-v2 |
| **LongMemEval** | overall accuracy | **≥ 85%** | per-type breakdown reported |
| **LongMemEval** | temporal-reasoning | **≥ 75%** | hardest bucket |
| **BEAM** | token_savings_pct | **≥ 90%** | ≤ 10% of corpus tokens per query |
| **BEAM** | recall_p95_ms | **< 200ms** | with HNSW or pgvector |
| **BEAM** | ingest_throughput | **> 100 docs/s** | pgvector COPY path |

`BEAM_STRICT=1` makes `bench:beam` exit non-zero on a missed target.
`SWEEP_STRICT=1` makes `bench:sweep` exit non-zero on any failed cell.

## CLI flags (apply to all 3 runners)

| Flag | Env | Default | Description |
|---|---|---|---|
| `--backend` | `GKS_BENCH_BACKEND` | `jsonl` | `jsonl` \| `hnsw` \| `pgvector` |
| `--provider` | — | `auto` | `auto` \| `ollama` \| `openai` \| `mock` |
| `--top-k` | `*_TOPK` | varies | top-K for retrieval |
| `--threshold` | `*_THRESHOLD` | varies | cosine score threshold |
| `--limit` | — | all | cap dataset items |
| `--rerank-endpoint` | `GKS_RERANK_ENDPOINT` | — | HTTP cross-encoder URL |
| `--rerank-api-key` | `GKS_RERANK_API_KEY` | — | bearer token |
| `--pg-url` | `DATABASE_URL` | — | required when `--backend=pgvector` |
| `--pg-table` | `GKS_VECTOR_TABLE` | `gks_vector` | multi-tenant override |
| `--hnsw-ef-search` | — | 40 | recall/latency knob |
| `--fresh` | — | `true` | wipe workdir before run |

Per-runner extras (e.g. BEAM's `--query-limit`, `--queries`, `--seed`) are
documented in each runner's header comment.

## What's missing

- **Cross-runner consolidator metric.** The Consolidator Three-Gate filter
  isn't currently scored — Phase 5 D.3 will add an ADR + test rig.
- **Streaming ingest mode.** Today every runner re-ingests on each cell. For
  10M-token BEAM runs we should reuse pgvector data across cells (sweep
  doesn't yet do this).
- **CI-time SOTA gate.** The current CI workflow runs the tiny-fixture smoke
  only. A separate, opt-in `bench-sota.yml` workflow with self-hosted runners
  is the right home for full-dataset numbers.
