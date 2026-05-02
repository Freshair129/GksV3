# ADR-016: Postpone Embedded Graph Backend (Kuzu)

## Status
Proposed (Postponed from MVP)

## Context
As defined in [ADR-008](./008-gks-storage-engine-scope.md) and [ADR-009](./009-msp-as-orchestrator.md), GKS requires a high-performance Graph Layer (Obsidian) for multi-hop traversals and impact analysis. The initial roadmap proposed three backends for this layer:
1.  **In-memory GraphStore** (Default): Fast, local, but non-persistent (rebuilds on startup).
2.  **Postgres Graph Backend** (B.3a): Production-grade, handles massive scale, requires a server.
3.  **Kuzu Embedded Backend** (B.3b): High-performance, persistent, but embedded (zero-ops).

## Decision
We will **postpone** the implementation of the Kuzu Embedded Backend (B.3b) beyond the v3 SOTA-production milestone.

## Rationale
1.  **MVP Focus**: The primary goal for v3 is to deliver a production-ready storage engine as quickly as possible.
2.  **Coverage**: The combination of the **In-memory GraphStore** (for local/small-scale dev) and **Postgres Graph Backend** (for production/large-scale) covers 99% of currently identified use cases.
3.  **Redundancy**: Since Atomic Files remain the Source of Truth, the graph is always reconstructible. For local developers, the startup penalty of re-indexing into the in-memory store is currently acceptable compared to the engineering effort of integrating and maintaining a C++ embedded engine like Kuzu.
4.  **Lean Architecture**: Reducing the number of required external dependencies (even embedded ones) simplifies the initial release and minimizes the maintenance surface.

## Consequences
- **Positive**: Shorter time-to-market for v3. Reduced complexity in the core library.
- **Negative**: Local users with extremely large knowledge bases (>10k atoms) will experience longer startup times due to mandatory re-indexing of the in-memory graph.
- **Mitigation**: Users requiring persistence or higher scale on local machines can use a local Docker-based Postgres instance, which is already supported via B.3a.
