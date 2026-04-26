"""
EVA-flavoured Memory OS — extends the generic kernel with EVA-specific
concepts that were previously hard-coded inside MSP-v9.1:

  • RMSEngineV6 integration (resonance / affect scoring)
  • L1 / L2 / L3 RI levels  (mapped to/from generic Importance)
  • Pulse Snapshot in episode metadata
  • THA_NN_SNN instance ID format
  • EVA's three cognitive memory tiers (episodic / semantic / sensory)
  • EVA's 8→1 / 8→1 cascade (session→core→sphere)

If you don't run EVA, you don't import this. The generic kernel works
on its own with default config.
"""

from __future__ import annotations

from typing import Any, Optional

from core.interfaces import (
    AffectPlugin,
    ConsolidationRule,
    Importance,
    MemoryOsConfig,
    WritePolicy,
)
from core.memory_os import MemoryOS

# ── L1/L2/L3 ↔ Importance ──────────────────────────────────────────────────
# EVA's RI scale → kernel's continuous Importance.
RI_TO_IMPORTANCE = {
    "L1": Importance.TRIVIAL,   # smalltalk
    "L2": Importance.MEDIUM,    # light
    "L3": Importance.CRITICAL,  # full episode
}

IMPORTANCE_TO_RI = {v: k for k, v in RI_TO_IMPORTANCE.items()}


class RiLevelWritePolicy:
    """
    EVA's L1/L2/L3 filtering: trim the episode body proportional to RI.

    Reproduces MSP-v9.1's _apply_ri_filter exactly — but lives in the
    plugin so the kernel doesn't carry EVA semantics.
    """

    def filter_for_write(
        self, episode: dict[str, Any], importance: Importance
    ) -> dict[str, Any]:
        # Always keep id + timestamp + emotive snapshot
        keep_min = {
            "episode_id": episode.get("episode_id"),
            "timestamp": episode.get("timestamp"),
            "emotive_snapshot": episode.get("emotive_snapshot", {}),
        }
        if importance == Importance.TRIVIAL:
            return keep_min
        if importance == Importance.MEDIUM:
            return {**keep_min, "summary": episode.get("summary", "")}
        # HIGH / CRITICAL → full episode
        return episode


# ── RMS plugin ─────────────────────────────────────────────────────────────

class RmsAffectPlugin:
    """
    Wraps EVA's RMSEngineV6 so the kernel can ask "how important is this
    raw signal?" without knowing what eva_matrix / rim_output / reflex /
    ri_total mean.
    """

    def __init__(self, rms_engine: Any) -> None:
        self.rms = rms_engine  # duck-typed: any object with .process(...)

    def compute_importance(self, raw_signal: dict[str, Any]) -> float:
        """
        Pull `ri_total` (0–1) out of the raw signal, run it through RMS
        for affective weighting, return a single float the kernel can map
        to Importance.
        """
        snapshot = self.rms.process(
            raw_signal.get("eva_matrix", {}),
            raw_signal.get("rim_output", {}),
            raw_signal.get("reflex_state", {}),
            raw_signal.get("ri_total", 0.0),
        )
        # RMS returns its own affect dict; extract a scalar weight. We
        # default to ri_total but plugins can override.
        return float(snapshot.get("weight", raw_signal.get("ri_total", 0.0)))

    def attach_affect_metadata(
        self, episode: dict[str, Any], raw_signal: dict[str, Any]
    ) -> dict[str, Any]:
        snapshot = self.rms.process(
            raw_signal.get("eva_matrix", {}),
            raw_signal.get("rim_output", {}),
            raw_signal.get("reflex_state", {}),
            raw_signal.get("ri_total", 0.0),
        )
        out = dict(episode)
        out["pulse_snapshot"] = snapshot
        return out


# ── EVA-flavoured Memory OS ───────────────────────────────────────────────

def eva_config() -> MemoryOsConfig:
    """Default EVA configuration (matches MSP-v9.1 defaults exactly)."""
    return MemoryOsConfig(
        in_session_tiers=["episodic", "semantic", "sensory"],
        consolidation_rules=[
            ConsolidationRule(from_tier="session", to_tier="core", every_n=8),
            ConsolidationRule(from_tier="core", to_tier="sphere", every_n=8),
        ],
        max_episodes_per_session=30,
        origin_name="EVA",
        instance_id_format="THA_{n:02d}_S01",
    )


class EvaMemoryOS(MemoryOS):
    """
    EVA-flavoured Memory OS — drop-in replacement for the original
    MSP-v9.1 class. All the EVA-specific knobs are wired in here; the
    actual orchestration logic lives in the generic kernel.
    """

    def __init__(
        self,
        storage: Any,
        rms_engine: Optional[Any] = None,
        validators: Optional[Any] = None,
        validation_mode: str = "strict",
    ) -> None:
        affect = RmsAffectPlugin(rms_engine) if rms_engine is not None else None
        super().__init__(
            storage=storage,
            config=eva_config(),
            validators=validators,
            write_policy=RiLevelWritePolicy(),
            affect_plugin=affect,
            validation_mode=validation_mode,
        )

    # ── Convenience wrappers in EVA's familiar terms ────────────────────

    def write_episode_eva(
        self,
        episode_data: dict[str, Any],
        ri_level: str = "L3",
        eva_affect_signal: Optional[dict[str, Any]] = None,
    ) -> str:
        """
        EVA-style write: takes a string RI level + optional raw affect
        signal. Kernel-side this becomes a generic write_episode call.
        """
        importance = RI_TO_IMPORTANCE.get(ri_level, Importance.HIGH)
        return self.write_episode(
            episode=episode_data,
            importance=importance,
            tier="episodic",
            affect_signal=eva_affect_signal,
        )

    def process_resonance(
        self,
        eva_matrix: dict[str, Any],
        rim_output: dict[str, Any],
        reflex_state: dict[str, Any],
        ri_total: float = 0.0,
    ) -> dict[str, Any]:
        """Direct RMS call for callers that want the raw snapshot."""
        if self.affect is None:
            raise RuntimeError("RMS plugin not configured")
        # The plugin owns the RMS reference; expose the same shape MSP
        # callers expect.
        return self.affect.attach_affect_metadata(
            {},
            {
                "eva_matrix": eva_matrix,
                "rim_output": rim_output,
                "reflex_state": reflex_state,
                "ri_total": ri_total,
            },
        )["pulse_snapshot"]
