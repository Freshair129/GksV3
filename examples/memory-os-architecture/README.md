# Memory OS — Layered Architecture

> Reference implementation showing how to separate **paradigm-agnostic Memory OS kernel** from **EVA-specific affect/consolidation logic** from **storage backend**.

This directory is a Python proof-of-concept that takes EVA's MSP-v9.1
(`MSP.py`, ~700 lines, all hard-coupled) and refactors it into three
clean layers:

```
┌────────────────────────────────────────────────────────────┐
│ Agent (any LLM)                                            │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│ Memory OS — kernel  (core/)                                │
│                                                            │
│  Owns: session lifecycle, sandbox, cascade orchestration,  │
│        versioning, validation pipeline                     │
│                                                            │
│  Knows nothing about: EVA, affect, files, storage details  │
└────────────────────────┬───────────────────────────────────┘
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
┌───────▼───────┐ ┌──────▼──────┐ ┌────────▼─────────┐
│ AffectPlugin  │ │ WritePolicy │ │ StorageBackend   │
│ (eva/)        │ │ (eva/)      │ │ (storage/)       │
│ RMS / Pulse   │ │ L1/L2/L3    │ │ JsonFile / GKS   │
│ EVA-only      │ │ EVA-only    │ │ swappable        │
└───────────────┘ └─────────────┘ └──────────────────┘
```

## Why separate

The original `MSP.py` mixed three concerns:

1. **Generic Memory OS** — session→core→sphere cascade, sandboxing,
   versioning, backup/verify, validation pipeline
2. **EVA-specific** — RMS, RI levels, eva_matrix, Pulse Snapshot
3. **Storage** — local JSON files in numbered directories

Anyone wanting to use the *kernel* in a non-EVA project had to either
rewrite half the file or import RMS just to satisfy the constructor. By
splitting along these seams:

- non-EVA agents use `MemoryOS` directly with default policies
- EVA stays a one-line subclass: `class EvaMemoryOS(MemoryOS)`
- swapping storage from local files → GKS is one line: change the
  `storage=` argument

## Files

```
examples/memory-os-architecture/
├── core/                       # paradigm-agnostic kernel
│   ├── interfaces.py           #   Protocols: StorageBackend,
│   │                           #     WritePolicy, ValidatorChain,
│   │                           #     AffectPlugin (~150 lines)
│   ├── defaults.py             #   default impls (~80 lines)
│   ├── memory_os.py            #   the kernel (~330 lines)
│   └── __init__.py
├── eva/                        # EVA-specific extensions
│   ├── eva_plugin.py           #   RmsAffectPlugin,
│   │                           #     RiLevelWritePolicy,
│   │                           #     EvaMemoryOS (~150 lines)
│   └── __init__.py
├── storage/                    # pluggable backends
│   ├── json_files.py           #   MSP-v9.1 file layout (~210 lines)
│   ├── gks_adapter.py          #   GKS via MCP (POC) (~250 lines)
│   └── __init__.py
├── smoke_test.py               # 3 scenarios, runnable demo
└── README.md                   # you are here
```

**~970 lines total** vs MSP-v9.1's ~700 lines monolith. The extra ~270
buys: clean interfaces, two backends, and the ability for any non-EVA
project to use the kernel.

## What moved where

| MSP-v9.1 concept | New location | Why |
|---|---|---|
| `RMSEngineV6` import + `process_resonance` | `eva/eva_plugin.py` | EVA-specific affect engine |
| `_apply_ri_filter` (L1/L2/L3) | `eva/eva_plugin.py` `RiLevelWritePolicy` | EVA's RI scale; generic kernel uses `Importance` enum |
| `Pulse Snapshot` integration | `eva/eva_plugin.py` `RmsAffectPlugin.attach_affect_metadata` | RMS-specific |
| `THA_NN_SNN` instance ID format | `eva/eva_plugin.py` `eva_config()` | Project-specific naming |
| Origin name `"EVA"` | `eva/eva_plugin.py` `eva_config()` | Per-deployment label |
| Hard-coded 8→1 / 8→1 cascade | `core/interfaces.py` `MemoryOsConfig.consolidation_rules` | Now data, not code |
| Hard-coded `01_..` / `02_..` numbered dirs | `storage/json_files.py` `_TIER_DIRS` | Storage-specific |
| Direct `open()` / `Path.glob()` | `storage/json_files.py` | All I/O goes through StorageBackend |
| `EpisodicValidator`, `SemanticValidator`, `SensoryValidator` | `core/interfaces.py` `ValidatorChain` | Plugin point; EVA's existing validators implement it |
| `ConfidenceUpdater` + `StakesLevel` | EVA-specific → would live in `eva/` (not yet ported, kernel uses simple confidence threshold instead) | EVA-specific epistemic model |
| Session lifecycle | `core/memory_os.py` `MemoryOS` | Generic — kept as-is |
| Origin / Buffer sandbox | `core/memory_os.py` + `storage/*.py` | Kernel orchestrates, storage implements |
| Pre-consolidation backup + verification | `core/memory_os.py` + `storage/*.py` | Same split |
| Counter-driven cascade triggering | `core/memory_os.py` `_evaluate_cascade` | Generic |

## Smoke test output

```
$ python3 smoke_test.py

======================================================================
  Scenario 1: Generic Memory OS — no EVA, no affect
======================================================================
  episode: ep_S01_001_1585db
  semantic: sem_S01_0f949e83
  end-of-session: {'session_id': 'S01', 'episode_count': 1, ...}
  ✓ generic OK

======================================================================
  Scenario 2: EvaMemoryOS + JsonFileStorage — drop-in MSP-v9.1
======================================================================
  ✓ L1 stripped body, L3 kept body + attached pulse_snapshot
  ✓ EVA-on-files OK

======================================================================
  Scenario 3: EvaMemoryOS + GksStorage — same OS, GKS backend
======================================================================
  ✓ episode landed in GKS via gks_retain
  ✓ EVA-on-GKS OK

  All 3 scenarios passed — separation is clean.
```

## Migrating MSP-v9.1 to this architecture

Step 1 — drop-in compatibility:

```python
# Before
from msp import MSP
m = MSP(base_path=Path("./eva_data"))

# After (zero behavioural change)
from storage import JsonFileStorage
from eva import EvaMemoryOS
from rms import RMSEngineV6  # your existing RMS

m = EvaMemoryOS(
    storage=JsonFileStorage("./eva_data"),
    rms_engine=RMSEngineV6(),
)
```

Step 2 — swap backend (optional):

```python
# Same EvaMemoryOS, GKS backend instead of files
from storage import GksStorage, InMemoryGksClient  # or your real MCP client

m = EvaMemoryOS(
    storage=GksStorage(InMemoryGksClient()),  # ← only line that changes
    rms_engine=RMSEngineV6(),
)
```

Step 3 — non-EVA project (no affect, simpler config):

```python
from core import MemoryOS, MemoryOsConfig
from storage import JsonFileStorage

m = MemoryOS(
    storage=JsonFileStorage("./agent_data"),
    config=MemoryOsConfig(
        in_session_tiers=["episodic"],          # single tier
        consolidation_rules=[],                  # no cascade
        origin_name="my_agent",
    ),
)
```

## What still needs work

- **`ConfidenceUpdater` + `StakesLevel`**: EVA's epistemic model
  (hypothesis → established → high-stakes locking) is currently
  approximated by a simple `confidence > 0.7` threshold. A proper port
  would give EVA back its full confidence machinery as another plugin.
- **GKS adapter `master_save` / `buffer_save`**: GKS is append-only; bulk
  replacement requires `patchMetadataMany` which the POC doesn't call.
  Real adapter would diff vs current state.
- **Real MCP client wiring**: `InMemoryGksClient` is a stub. Production
  use needs `mcp[client]` Python SDK pointed at `npx gks-mcp-server`.
- **EVA's existing validators** (`EpisodicValidator`, etc.): currently
  the kernel uses `MinimalValidatorChain`; wiring up the real ones is a
  matter of writing an `EvaValidatorChain` that wraps them.

## Relationship to GKS v3

This example **uses** `gks-mcp-server` as one of two storage backends —
it doesn't modify GKS itself.

The architectural insight (the actual deliverable):

> **MSP = Memory OS** (kernel — policies, scheduling, hierarchy)
> **GKS = Storage Engine** (block device — persistence, indexing, queryability)
>
> They're complementary layers, not competing systems.

GKS's scope stays tight (storage only). MSP's scope stays focused
(Memory OS only). The bridge between them is a thin StorageBackend
adapter — see `storage/gks_adapter.py`.
