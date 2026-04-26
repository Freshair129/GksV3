"""
Smoke test: prove the 3-layer separation actually works.

Two scenarios:
  1. Generic Memory OS + JsonFileStorage — non-EVA agent, no affect
  2. EvaMemoryOS + JsonFileStorage      — drops in for MSP-v9.1
  3. EvaMemoryOS + GksStorage (in-mem)  — same EVA OS, different backend

Run from this directory:
    python smoke_test.py
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from core import Importance, MemoryOS, MemoryOsConfig
from eva import EvaMemoryOS
from storage import GksStorage, InMemoryGksClient, JsonFileStorage


# ── Mock RMS engine — duck-typed, no eva.* import required ──────────────

class MockRms:
    """Stands in for RMSEngineV6 so the example runs without EVA installed."""

    def process(self, eva_matrix, rim_output, reflex_state, ri_total):
        return {
            "weight": float(ri_total),
            "valence": eva_matrix.get("social_warmth", 0.0)
            - eva_matrix.get("stress_load", 0.0),
            "intensity": rim_output.get("intensity", 0.5),
        }


def header(s: str) -> None:
    print("\n" + "=" * 70)
    print(f"  {s}")
    print("=" * 70)


def scenario_1_generic():
    header("Scenario 1: Generic Memory OS — no EVA, no affect")

    tmp = Path(tempfile.mkdtemp(prefix="memos_generic_"))
    try:
        os = MemoryOS(
            storage=JsonFileStorage(tmp),
            config=MemoryOsConfig(
                origin_name="generic_agent",
                in_session_tiers=["episodic", "semantic"],
                instance_id_format="agent_{n:03d}",
            ),
        )
        os.create_instance()
        os.start_session()
        ep_id = os.write_episode(
            {"summary": "Hello world", "timestamp": "2026-04-26T00:00:00Z"},
            importance=Importance.HIGH,
        )
        sem_id = os.write_semantic(
            concept="greeting", definition="hello-world handshake",
            episode_id=ep_id, confidence=0.9,
        )
        result = os.end_session()
        print(f"  episode: {ep_id}")
        print(f"  semantic: {sem_id}")
        print(f"  end-of-session: {result}")
        assert result["episode_count"] == 1
        print("  ✓ generic OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def scenario_2_eva_files():
    header("Scenario 2: EvaMemoryOS + JsonFileStorage — drop-in MSP-v9.1")

    tmp = Path(tempfile.mkdtemp(prefix="memos_eva_"))
    try:
        os = EvaMemoryOS(
            storage=JsonFileStorage(tmp),
            rms_engine=MockRms(),
            validation_mode="off",
        )
        os.create_instance()  # auto: THA_01_S01
        os.start_session()    # auto: S01

        # L1 smalltalk — body should be stripped by RiLevelWritePolicy
        os.write_episode_eva(
            {"summary": "hi", "long_body": "should be stripped",
             "emotive_snapshot": {"intensity": 0.1}},
            ri_level="L1",
        )
        # L3 critical — full episode kept + pulse snapshot attached
        os.write_episode_eva(
            {"summary": "deep conversation", "long_body": "kept verbatim",
             "emotive_snapshot": {"intensity": 0.8}},
            ri_level="L3",
            eva_affect_signal={
                "eva_matrix": {"stress_load": 0.2, "social_warmth": 0.9},
                "rim_output": {"intensity": 0.8},
                "reflex_state": {"threat_level": 0.0},
                "ri_total": 0.85,
            },
        )

        result = os.end_session()
        print(f"  end-of-session: {result}")
        assert result["episode_count"] == 2
        # Verify RI filtering actually happened
        ep_file = tmp / "Buffer" / "instance_THA_01_S01" / "01_Episodic_memory" / "Episodic_memory.json"
        import json as _json
        episodes = _json.loads(ep_file.read_text())["episodes"]
        assert "long_body" not in episodes[0], "L1 should strip long_body"
        assert episodes[1].get("long_body") == "kept verbatim", "L3 keeps body"
        assert episodes[1].get("pulse_snapshot"), "RMS should attach pulse_snapshot"
        print("  ✓ L1 stripped body, L3 kept body + attached pulse_snapshot")
        print("  ✓ EVA-on-files OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def scenario_3_eva_gks():
    header("Scenario 3: EvaMemoryOS + GksStorage — same OS, GKS backend")

    client = InMemoryGksClient()
    os = EvaMemoryOS(
        storage=GksStorage(client),
        rms_engine=MockRms(),
        validation_mode="off",
    )
    os.create_instance("THA_01_S01")
    os.start_session("S01")

    os.write_episode_eva(
        {"summary": "EVA → GKS round-trip test",
         "emotive_snapshot": {"intensity": 0.6}},
        ri_level="L3",
        eva_affect_signal={
            "eva_matrix": {"stress_load": 0.3, "social_warmth": 0.8},
            "rim_output": {"intensity": 0.6},
            "reflex_state": {"threat_level": 0.1},
            "ri_total": 0.7,
        },
    )

    result = os.end_session()
    print(f"  end-of-session: {result}")
    # GKS in-memory client should now have items in the
    # (memory_os, instance, tier, container) namespace
    assert any(
        "EVA → GKS round-trip test" in str(d)
        for docs in client._store.values()
        for d in docs
    ), "GKS should have received the episode via gks_retain"
    print("  ✓ episode landed in GKS via gks_retain")
    print("  ✓ EVA-on-GKS OK")


if __name__ == "__main__":
    scenario_1_generic()
    scenario_2_eva_files()
    scenario_3_eva_gks()
    print("\n" + "=" * 70)
    print("  All 3 scenarios passed — separation is clean.")
    print("=" * 70)
