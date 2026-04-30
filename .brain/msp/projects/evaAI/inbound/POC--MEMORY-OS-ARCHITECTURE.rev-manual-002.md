---
proposed_id: POC--MEMORY-OS-ARCHITECTURE
review_id: rev-manual-002
phase: 1
type: poc
status: raw
proposed_at: 2026-04-30T09:00:00Z
title: Memory OS can layer on GKS via MCP without storage-engine changes
hypothesis: |
  A paradigm-agnostic Memory OS (kernel) can be implemented above GKS using
  only the public retain / recall / reflect contract, with EVA-specific
  cognitive concerns (RI levels, RMS affect, Session→Core→Sphere cascade)
  living in a separate plugin module. GKS itself requires no Memory-OS-aware
  changes. If true, this validates the layering proposed in ADR-008.
acceptance_criteria:
  - Memory OS kernel runs end-to-end against gks-mcp-server via stdio
  - EVA-specific behaviour (affect / RI / cascade) lives only in the plugin module
  - GKS source has zero Memory-OS-specific imports or hooks
  - Storage adapter swap (`JsonFile` ↔ `Gks`-via-MCP) requires no kernel changes
  - Reference implementation is reproducible by a third party from README
time_box:
  opened_at: 2026-04-15T00:00:00Z
  deadline: 2026-04-26T00:00:00Z
  closed_at: 2026-04-26T00:00:00Z
linked_symbols:
  - { file: examples/memory-os-architecture/, fn: README }
  - { file: examples/memory-os-architecture/core/memory_os.py, fn: MemoryOS }
  - { file: examples/memory-os-architecture/plugins/eva.py, fn: EvaPlugin }
  - { file: examples/memory-os-architecture/storage/, fn: JsonFile }
  - { file: examples/memory-os-architecture/storage/, fn: GksMcp }
crosslinks:
  derives_from: []                              # no canonical CONCEPT-- existed at the time
  produces: []                                  # informal — no AUDIT-- atom written
  feeds_into:
    - ADR--GKS-STORAGE-ENGINE-SCOPE             # ADR-008, accepted on the strength of this POC
    - ADR--MSP-AS-ORCHESTRATOR                  # ADR-009, builds on the same layering
  references:
    - CONCEPT--MEMORY-STORE
---

# POC — Memory OS can layer on GKS via MCP without storage-engine changes

## Backfill notice

This atom is filed retroactively. The POC was completed and informed
ADR-008 + ADR-009 before the `POC--` prefix existed (see
`ADR--ADD-POC-PREFIX`). It is being recorded now to:

1. Demonstrate the proposed `POC--` prefix on real prior art.
2. Make the experiment that justifies ADR-008's layering visible in
   the atom graph instead of buried in `examples/`.
3. Establish the precedent that `examples/<name>/` directories
   labelled "proof-of-concept" should carry a `POC--` atom going
   forward.

## Hypothesis (as stated above)

A paradigm-agnostic Memory OS kernel can be implemented above GKS
using only the public `retain` / `recall` / `reflect` contract, with
EVA-specific behaviour confined to a plugin module.

## Method

A Python reference implementation under
`examples/memory-os-architecture/` was built with three layers:

- **`core/memory_os.py`** — paradigm-agnostic kernel. Owns session
  lifecycle, consolidation cascade scheduling, sandbox/origin-buffer
  separation. Knows nothing about EVA.
- **`plugins/eva.py`** — EVA-specific extensions. Holds RI levels,
  RMS affect scoring, Session→Core→Sphere cascade timing, the 8→1
  consolidation rule. Plugged into the kernel via an extension point.
- **`storage/`** — two interchangeable adapters:
  - `JsonFile` — local JSONL-backed store for unit-test isolation
  - `GksMcp` — talks to `gks-mcp-server` over stdio MCP

Tested by:

1. Running the kernel with `JsonFile` adapter through a scripted
   session lifecycle (open → retain → recall → reflect → close).
2. Swapping to `GksMcp` adapter against a live `gks-mcp-server` and
   re-running the same scripted session.
3. Verifying `git grep` of `src/` for any Memory-OS-specific symbols
   returned zero results.

## Result

**Status:** validated.

**Evidence:**

- ✅ Both adapters drove the kernel through identical scripted sessions
  with no kernel modifications between runs.
- ✅ EVA-specific code (RI levels, RMS affect, cascade timing) appears
  only in `plugins/eva.py` — the kernel is paradigm-agnostic.
- ✅ `git grep -r "memory_os\|RI_level\|RMS" src/` returns zero hits;
  GKS source has no Memory-OS coupling.
- ✅ Storage adapter swap required zero kernel changes; the `Storage`
  Protocol contract held.
- ✅ A walkthrough README (`examples/memory-os-architecture/README.md`)
  documents the reproduction path.

**Decision derived (`feeds_into`):**

- **ADR-008** — *GKS as storage engine; Memory OS layer above
  (MSP-shaped contract).* This POC's success was the empirical
  evidence that layering works without GKS absorbing Memory-OS
  concerns.
- **ADR-009** — *MSP orchestrates peer subsystems; GKS does not
  proxy them.* The plugin-vs-kernel split discovered here generalises
  to peer subsystems (e.g. GitNexus) — the orchestrator owns
  composition, individual peers stay narrow.

## Notes for future POC authors

- The `Storage` Protocol contract was the smallest viable interface;
  resist temptation to widen it. Both `JsonFile` and `GksMcp` were
  implementable with ~80 lines each.
- The plugin extension point in `core/memory_os.py:220`
  (`epistemic_status`) was the ergonomic discovery — carrying
  `hypothesis → established → locked` as a *field* on items rather
  than a *type* of item is what made the layering clean. This pattern
  is what `ADR--ADD-POC-PREFIX` argues makes `POC--` distinct from
  status-overloading existing atoms.
- Time-box compliance was informal here (no `gks poc` CLI existed).
  Going forward, any POC labelled in README should carry a `POC--`
  atom with a real deadline.

## References

- `examples/memory-os-architecture/README.md` — full walkthrough
- `examples/memory-os-architecture/core/memory_os.py` — kernel
- `examples/memory-os-architecture/plugins/eva.py` — EVA plugin
- `examples/memory-os-architecture/storage/` — adapters
- `docs/MSP_RELATIONSHIP.md` — the contract this POC validated
- `ADR--ADD-POC-PREFIX` — the proposal this atom backs as worked example
