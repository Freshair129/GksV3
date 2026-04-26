"""
Memory OS — pluggable interfaces.

These Protocols define the contract between the generic kernel and the
swappable parts (storage, validation, write policy, RMS-style affect
plugins). Any class that satisfies a Protocol's methods can plug in —
no inheritance required (duck typing, Python style).

Design intent:
  • core/memory_os.py knows nothing about EVA / files / affect
  • All EVA-specific concepts live in eva/eva_plugin.py
  • All storage details live in storage/*.py
  • All validation rules live behind ValidatorChain
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional, Protocol, runtime_checkable


# ── Importance ────────────────────────────────────────────────────────────
# EVA's MSP uses discrete "L1/L2/L3" RI levels. We generalize to a continuous
# 0.0–1.0 importance with a discrete enum on top — implementations can use
# either (or both, like the EVA plugin does).

class Importance(float, Enum):
    """Coarse importance buckets, normalised to 0–1."""
    TRIVIAL = 0.1   # smalltalk — keep id + timestamp + state only
    LOW = 0.3
    MEDIUM = 0.5   # light — + summary
    HIGH = 0.7
    CRITICAL = 0.9  # full episode

    @classmethod
    def from_float(cls, x: float) -> "Importance":
        thresholds = [
            (cls.CRITICAL, 0.8),
            (cls.HIGH, 0.6),
            (cls.MEDIUM, 0.4),
            (cls.LOW, 0.2),
            (cls.TRIVIAL, 0.0),
        ]
        for level, t in thresholds:
            if x >= t:
                return level
        return cls.TRIVIAL


# ── Validation result ─────────────────────────────────────────────────────

@dataclass
class ValidationResult:
    valid: bool
    errors: list[str] = field(default_factory=list)
    context: dict[str, Any] = field(default_factory=dict)


# ── Pluggable interfaces ──────────────────────────────────────────────────

@runtime_checkable
class WritePolicy(Protocol):
    """
    Decides how an episode is shaped at write time. The default keeps the
    episode whole; the EVA plugin uses this hook to apply RI-level
    filtering (L1 strips body, L2 keeps summary only, L3+ keeps everything).
    """

    def filter_for_write(
        self, episode: dict[str, Any], importance: Importance
    ) -> dict[str, Any]: ...


@runtime_checkable
class ValidatorChain(Protocol):
    """
    Schema + conflict + confidence pipeline. Implementations may chain
    multiple validators internally; the kernel only sees this aggregate
    interface.
    """

    def validate_episode(
        self, episode: dict[str, Any], importance: Importance
    ) -> ValidationResult: ...

    def validate_semantic(
        self, entry: dict[str, Any], existing_entries: list[dict[str, Any]]
    ) -> ValidationResult: ...

    def validate_sensory(self, entry: dict[str, Any]) -> ValidationResult: ...

    def is_consolidation_eligible(self, entry: dict[str, Any]) -> bool: ...


@runtime_checkable
class StorageBackend(Protocol):
    """
    Where bytes physically live. Two-layer model:
      • buffer  = per-instance sandbox (writable during a session)
      • master  = origin / canonical state (read-only during a session,
                  promoted to via consolidate_to_origin)

    All operations are per-tier (e.g. 'episodic', 'semantic', 'sensory',
    'session', 'core', 'sphere'). Tier names are config-driven, not
    hard-coded — the JSON-file backend maps them to numbered subdirs;
    the GKS backend maps them to namespaces.
    """

    # ---- buffer (instance-scoped) ----
    def buffer_append(
        self, instance_id: str, tier: str, container_key: str, item: dict[str, Any]
    ) -> None: ...

    def buffer_load(
        self, instance_id: str, tier: str, container_key: str
    ) -> dict[str, Any]: ...

    def buffer_save(
        self, instance_id: str, tier: str, container_key: str, data: dict[str, Any]
    ) -> None: ...

    def buffer_init(self, instance_id: str, metadata: dict[str, Any]) -> None: ...

    def buffer_delete(self, instance_id: str) -> None: ...

    def buffer_metadata(
        self, instance_id: str, patch: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]: ...

    # ---- master (origin) ----
    def master_load(self, tier: str) -> dict[str, Any]: ...

    def master_save(self, tier: str, data: dict[str, Any]) -> None: ...

    def master_backup(self, version: int) -> str: ...

    # ---- consolidation snapshots (session / core / sphere files) ----
    def snapshot_save(self, tier: str, snapshot_id: str, data: dict[str, Any]) -> None: ...

    def snapshot_load(self, tier: str, snapshot_id: str) -> dict[str, Any]: ...

    def snapshot_list(self, tier: str) -> list[str]: ...

    # ---- versioning ----
    def get_version_state(self) -> dict[str, Any]: ...

    def set_version_state(self, state: dict[str, Any]) -> None: ...


@runtime_checkable
class AffectPlugin(Protocol):
    """
    Optional plugin slot for affect-aware Memory OS implementations
    (e.g. EVA's RMS/RI). The kernel calls this when present to compute
    importance from raw signal — but never knows what the signal looks
    like internally.
    """

    def compute_importance(self, raw_signal: dict[str, Any]) -> float: ...

    def attach_affect_metadata(
        self, episode: dict[str, Any], raw_signal: dict[str, Any]
    ) -> dict[str, Any]: ...


# ── Configuration ─────────────────────────────────────────────────────────

@dataclass
class ConsolidationRule:
    """
    "Every N units in `from_tier`, fold them into one unit in `to_tier`."

    EVA's MSP hard-codes 8 sessions → 1 core → 1 sphere; this lets us
    express the same cascade as data (and configure other systems
    differently — e.g. 100 sessions → 1 weekly review).
    """
    from_tier: str
    to_tier: str
    every_n: int


@dataclass
class MemoryOsConfig:
    """
    Pluggable configuration. Tier names + cascade rules are data; only
    the orchestration logic lives in the kernel.
    """
    # In-session memory categories. Default mirrors EVA's three
    # cognitive-psych categories but a non-EVA system might use, say,
    # ['conversational', 'factual'] only.
    in_session_tiers: list[str] = field(
        default_factory=lambda: ["episodic", "semantic", "sensory"]
    )
    # Consolidation cascade. Default mirrors EVA's session→core→sphere.
    consolidation_rules: list[ConsolidationRule] = field(
        default_factory=lambda: [
            ConsolidationRule(from_tier="session", to_tier="core", every_n=8),
            ConsolidationRule(from_tier="core", to_tier="sphere", every_n=8),
        ]
    )
    max_episodes_per_session: int = 30
    # Origin name appears in the master state header; pure label.
    origin_name: str = "default"
    # Instance ID generator — default uses an auto-incrementing index;
    # EVA overrides to use Thai-prefixed THA_NN_SNN format.
    instance_id_format: str = "instance_{n:03d}"
