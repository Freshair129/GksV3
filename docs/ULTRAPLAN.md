# GKS v3 — Ultraplan (Roadmap to SOTA Production)

**Document version:** v3 (Post-ADR-015 Refactor)
**Repo state at writing:** PR #1 `claude/build-gks-v3-W8a7V` — 82 commits, 309 tests, CI green
**Reference spec:** `BLUEPRINT--memory` (EVA Tri-Brain architecture)

---

## Where we are

Phase 1, 2, 4, and 5 are **DONE**. The core engine is now production-grade.
The current branch ships:

- **Full Infrastructure Adapters**: `pgvector`, `hnswlib`, and `Postgres Graph` are all implementation-complete and tested.
- **Production Hardening**: Full **OpenTelemetry** integration, **Circuit Breakers**, **Retry logic**, and **Multi-tenancy** (Namespacing) are first-class.
- **Cost & Token Intelligence**: Integrated tracking for USD/token usage per session and provider.
- **Developer Experience**: GKS is available as an **MCP Server** and **CLI**.
- **Refined Taxonomy (ADR-015)**: Task tracking has been officially moved to the orchestrator layer (MSP/evaAI), cleaning up the GKS memory lifecycle.

What's missing to reach the final SOTA milestone:
1. Real-scale benchmark results (Runners are ready, full sweeps pending)
2. Release automation (Changesets setup)
3. B.3b Kuzu (Optional alternative for embedded graph)

---

## Phase 2B — Infra Adapters `[90% DONE]`

Each item is a self-contained backend that drops into an existing interface.

### [x] B.1 — pgvector backend
### [x] B.2 — HNSW in-process backend
### [x] B.3a — Postgres graph backend 🌟
### [ ] B.3b — Kuzu embedded graph backend (POSTPONED — See ADR-016)
### [x] B.4 — MCP-stdio transport for Obsidian
### [x] B.5 — Cross-encoder reranker fixtures

---

## Phase 3 — Real-Scale Benchmark Sweep `[IN PROGRESS]`

Targets are derived from the user spec (§5) and SOTA references
(ByteRover 2.0, EverOS).

### [/] G3.1 — LoCoMo against full HuggingFace dataset
### [/] G3.2 — LongMemEval (full set)
### [/] G3.3 — BEAM @ 10M tokens
### [x] G3.4 — Reproducible benchmark report


- Single command: `make benchmarks` produces JSON + markdown summary
- Embedder model versions pinned in the manifest so historical numbers
  remain comparable

---

## Phase 4 — Production Hardening `[DONE]`

### [x] H.1 — Observability
### [x] H.2 — Resilience
### [x] H.3 — Multi-tenancy
### [x] H.4 — Cost & token tracking
### [x] H.5 — Schema migration tooling

---

## Phase 5 — Developer Experience `[DONE]`

### [x] D.1 — GKS as an MCP server
### [x] D.2 — REPL / CLI
### [x] D.3 — Architecture documentation (ADR-001 to ADR-015)

---

## Phase 6 — Release `[IN PROGRESS]`

### [x] R.1 — semver + changelog
- Current version: **v3.5.4**
- Needs: `changesets` setup for automated releases

### [/] R.2 — npm publish
- Ready to publish under `@evaai/gks`

---

## Dependency Graph

```
B.1 (pgvector)  ─────┬──→ B.3a (PG graph)  ─────┐
                     │                           │
B.2 (HNSW)         ──┤   (alt: B.3b Kuzu)        │
B.4 (MCP stdio)    ──┼─→  G3.x (real benchmarks) ─→  R.1 → R.2
B.5 (rerank fix)   ──┘                           ↑
                                                 │
H.1 H.2 H.3 H.4 H.5  ───────────────────────────┘

D.1 (MCP server)  needs the MCP SDK introduced by B.4
D.2 (CLI)         independent
D.3 (ADRs)        independent
```

**Critical path:** `B.1 → B.3a → G3.1 → G3.2 → G3.3 → R.1` ≈ **6–8 days
sequential**.
**Parallel best case (3 streams):** ≈ **3–4 days** to the first SOTA-claim
benchmark run.

---

## Effort Summary

| Phase | Items | Sequential | Parallel best |
|---|---|---|---|
| 2B Infra adapters | 5 | ~6d | ~2.5d |
| 3 Real benchmarks | 4 | ~4d | ~3d |
| 4 Production hardening | 5 | ~7d | ~3d |
| 5 Developer experience | 3 | ~3d | ~1.5d |
| 6 Release | 2 | ~1d | ~1d |
| **Total** | **19** | **~21d** | **~10.5d** |

---

## Decision log

| Decision | Rationale |
|---|---|
| **Cut FalkorDB** (was B.3 in v1) | SSPL license blocks SaaS, no native bi-temporal support, requires running a separate Redis-protocol service. |
| **B.3a Postgres tables** chosen as primary | Free if B.1 ships first (shared instance); transactional consistency with pgvector; PostgreSQL license is permissive; SQL recursive CTEs handle our BFS needs. |
| **B.3b Kuzu** postponed (ADR-016) | Overkill for MVP; coverage provided by In-memory + Postgres; focus on lean release. |
| **Skip Neo4j** | Overkill for our scale (≤ 10M edges), heavy ops, AGPL/commercial license drama. |
| **Skip Apache AGE** | Postgres extension is finicky, version conflicts with pgvector reported in the wild. |

---

## What this plan does **not** cover

These are out of scope for the SOTA-production milestone but worth tracking:

- Federated / multi-region deployment
- Knowledge distillation (compressing old episodic to gist embeddings)
- Self-hosted reranker fine-tuning
- Plugin system for tools (currently a static registry per `FRAME`)
- Web UI / dashboard (CLI + MCP server are the supported surfaces)
- Real-time streaming retrieval (current model is request/response)

---

*See `BLUEPRINT--memory` for layer specifications.*
