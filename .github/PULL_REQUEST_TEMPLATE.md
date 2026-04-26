<!--
Default PR template — encodes the bar from ADR-011 (test policy) +
SCOPE.md (in/out of scope) + ADR-008 / ADR-009 (layer boundaries).
Delete sections that don't apply.
-->

## Summary

<!-- 1-3 sentences on what changes and why. Link the issue / ADR if any. -->

## Architectural fit

<!-- Optional but encouraged for non-trivial changes. -->

- **Scope** ([`SCOPE.md`](../SCOPE.md)): does this stay inside the storage-engine boundary?
- **Layer boundary** ([ADR-008](../docs/adr/008-gks-storage-engine-scope.md), [ADR-009](../docs/adr/009-msp-as-orchestrator.md)): does this avoid pulling Memory-OS / orchestration / code-intelligence work into `src/`?
- **Decision record**: if this changes a load-bearing behaviour, is there a new ADR or an update to an existing one?

## Files

<!--
Optional. A short table beats a wall of stats. Mark new files (+) and
modified files (M).

| File | What |
|---|---|
| + foo.ts | new helper for X |
| M bar.ts | wires in the helper |
-->

## Test plan ([ADR-011](../docs/adr/011-test-policy.md))

For changes that add or change public surface (a class, a function, a flag, a tool, a frontmatter field):

- [ ] Tests live in the **same commit** as the implementation
- [ ] **Happy path** — obvious correct call returns obvious correct result
- [ ] **At least one edge case** — empty input, missing field, invalid value, namespace boundary, concurrent access (pick what matters)
- [ ] **Failure mode** — asserts *what* is thrown / rejected, not just *that*
- [ ] **Surface coverage** — if reachable via TS + CLI + MCP, at least one E2E per surface (one round-trip per surface, not full duplication)
- [ ] **Hermetic** — runs offline, no flakes, no time-of-day deps (`GKS_EMBEDDER=mock` for anything embedder-touching)

For refactor / perf / doc changes:

- [ ] Existing tests still pass
- [ ] (If non-trivial) at least one regression-anchor test, or "test gap accepted" in the commit message

## Verification

- [ ] `npm run typecheck` clean
- [ ] `npm test` — all green locally before push
- [ ] CI matrix (Node 20 + 22) green

## Out of scope (if the topic might raise the question)

<!--
Optional. Pre-empt scope creep questions:
- This does not touch Memory-OS / consolidation timing (orchestrator's job per ADR-008)
- This does not parse code / call graph (GitNexus's job per ADR-009)
- This does not enforce workflow gates (CI / process layer)
-->

---

_Closes #?  ·  Related #?_
