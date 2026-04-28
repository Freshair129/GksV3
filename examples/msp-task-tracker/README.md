# MSP-shaped Task Tracker Stub (ADR-015)

This example demonstrates the **orchestrator-side task tracking contract** defined in [ADR-015](../../docs/adr/015-task-tracking-at-orchestrator.md).

> **Important**: This stub demonstrates the orchestrator-side contract from ADR-015. A real MSP layer would add scheduling, multi-agent dispatch, retries, and a dashboard. Those are deliberately not in GKS.

## Context

Per ADR-015, live execution state (task status, assignee, comments, microtask prompts) does not belong in GKS. GKS is for **durable knowledge**. Tasks churn too fast and have zero retrieval value once closed, so they live in the orchestrator (e.g. MSP).

## The Seam

1.  **Durable Start**: GKS provides a `BLUEPRINT--` atom. The orchestrator reads its `geography` (file paths).
2.  **Execution Churn**: The orchestrator creates tasks in its own storage (e.g., `.brain/<ns>/tasks/` or an external API like Linear). Status changes from `open` → `in_progress` → `done`.
3.  **Durable End**: Once all tasks for a blueprint are `done`, the orchestrator "closes the loop" by proposing an `AUDIT--` atom back to GKS via `proposeInbound()`.

## Files

- `tracker.ts`: Pure functions managing the file-backed JSON state for tasks.
- `state.example.json`: Sample shape of the orchestrator-side task state.
- `smoke.ts`: End-to-end demo that inits a GKS repo, runs a task lifecycle, and lands an audit candidate.

## Usage

```bash
# From the repo root
npx tsx examples/msp-task-tracker/smoke.ts
```

## How to use this in a real MSP

In a real Memory OS, you would:
1.  Watch the GKS index for new `BLUEPRINT--` atoms.
2.  Auto-initialize tasks in your database.
3.  Dispatch tasks to agents via their private sessions.
4.  When a session completes a task, update your state.
5.  When all tasks for a blueprint are finished, generate a summary and call `gks_propose_inbound` (MCP) or `store.proposeInbound` (API).
