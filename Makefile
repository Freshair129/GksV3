# GKS v3 — Benchmark Makefile
# Targets derived from ULTRAPLAN.md Phase 3

.PHONY: all benchmarks locomo longmemeval beam sweep clean

# Default: run the full suite across backends
benchmarks: sweep

# Individual runners with tiny datasets (sanity check)
locomo:
	$env:LOCOMO_DATASET="benchmarks/data/locomo-tiny.json"; npm run bench:locomo -- --provider=mock

longmemeval:
	$env:LONGMEMEVAL_DATASET="benchmarks/data/longmemeval-tiny.json"; npm run bench:longmemeval -- --provider=mock

beam:
	$env:BEAM_CORPUS="benchmarks/data/beam-tiny.jsonl"; npm run bench:beam -- --provider=mock

# The full sweep (produces JSON + Markdown in benchmarks/reports/)
sweep:
	npm run bench:sweep -- --config=benchmarks/sweep.example.json

# SOTA claim run (requires Ollama + PG)
sota:
	npm run bench:sweep -- --backends=pgvector,hnsw --providers=ollama --rerankers=lexical

clean:
	rm -Recurse -Force benchmarks/.cache
