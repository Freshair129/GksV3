"""
Memory OS — generic kernel.

Manages session lifecycle, instance/buffer sandboxing, consolidation
cascade, and versioning + backup. Paradigm-agnostic: knows nothing
about EVA, RMS, files, or affect.

What changed vs MSP-v9.1 (Python):
  • RMSEngineV6 import + process_resonance() → moved to eva/eva_plugin.py
  • L1/L2/L3 RI levels → generalised to Importance enum (interfaces.py)
  • Hard-coded "episodic/semantic/sensory" + numbered dirs → driven by
    MemoryOsConfig.in_session_tiers (defaults to those three for EVA
    compatibility, but trivially swappable)
  • Hard-coded 8→1→8→1 cascade → MemoryOsConfig.consolidation_rules
  • Direct file I/O → delegated to StorageBackend
  • EVA-specific schema validators → ValidatorChain plugin
  • THA_NN_SNN instance ID format → MemoryOsConfig.instance_id_format
  • Pulse Snapshot → AffectPlugin.attach_affect_metadata (optional)
  • Origin name "EVA" → MemoryOsConfig.origin_name (default "default")

Same-shape concepts kept (these ARE the Memory OS responsibility, not
EVA-specific):
  • Origin / Buffer sandbox
  • Pre-consolidation backup + post-write verification
  • Counter-driven auto-trigger of cascading consolidation
  • Atomic writes (delegated to StorageBackend's implementation)
  • Validation pipeline orchestration
  • Instance / session lifecycle
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from .defaults import DEFAULT_VALIDATOR_CHAIN, DEFAULT_WRITE_POLICY
from .interfaces import (
    AffectPlugin,
    ConsolidationRule,
    Importance,
    MemoryOsConfig,
    StorageBackend,
    ValidatorChain,
    WritePolicy,
)


class MemoryOSError(Exception):
    pass


class ConsolidationError(MemoryOSError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class MemoryOS:
    """
    Generic Memory OS kernel.

    Ownership:
      • Session timing            (start_session / end_session)
      • Instance sandboxing       (create_instance / delegate to storage)
      • Consolidation orchestration (counter checks + tier cascade)
      • Versioning + backup       (delegated to storage but timed by kernel)
      • Validation invocation     (delegated to ValidatorChain)

    NOT owned (delegated or out-of-scope):
      • Persistence details       → StorageBackend
      • Affect / RI computation    → AffectPlugin (optional)
      • Schema specifics           → ValidatorChain
      • Episode shape rules        → WritePolicy
    """

    def __init__(
        self,
        storage: StorageBackend,
        config: Optional[MemoryOsConfig] = None,
        validators: Optional[ValidatorChain] = None,
        write_policy: Optional[WritePolicy] = None,
        affect_plugin: Optional[AffectPlugin] = None,
        validation_mode: str = "strict",  # strict | warn | off
    ) -> None:
        self.storage = storage
        self.config = config or MemoryOsConfig()
        self.validators = validators or DEFAULT_VALIDATOR_CHAIN
        self.write_policy = write_policy or DEFAULT_WRITE_POLICY
        self.affect = affect_plugin
        self.validation_mode = validation_mode

        # Active context (volatile)
        self.instance_id: Optional[str] = None
        self.session_id: Optional[str] = None
        self.session_episode_count: int = 0

    # ── 1. Origin (master state) ────────────────────────────────────────

    def load_origin(self) -> dict[str, Any]:
        """
        Snapshot read-only view of master state for the active session.
        """
        snapshot = {
            "origin_name": self.config.origin_name,
            "version": self._current_version(),
            "loaded_at": _now(),
        }
        for tier in self.config.in_session_tiers:
            snapshot[f"{tier}_master"] = self.storage.master_load(tier)
        return snapshot

    # ── 2. Instance / sandbox ───────────────────────────────────────────

    def create_instance(self, instance_id: Optional[str] = None) -> str:
        if instance_id is None:
            n = self.storage.get_version_state().get("instance_serial", 0) + 1
            instance_id = self.config.instance_id_format.format(n=n)
            state = self.storage.get_version_state()
            state["instance_serial"] = n
            self.storage.set_version_state(state)

        self.instance_id = instance_id
        self.storage.buffer_init(
            instance_id,
            metadata={
                "instance_id": instance_id,
                "origin_name": self.config.origin_name,
                "created_at": _now(),
                "session_count": 0,
                "status": "active",
            },
        )
        return instance_id

    # ── 3. Session lifecycle ────────────────────────────────────────────

    def start_session(self, session_id: Optional[str] = None) -> str:
        if self.instance_id is None:
            raise MemoryOSError("create_instance() must be called first")

        if session_id is None:
            meta = self.storage.buffer_metadata(self.instance_id)
            n = meta.get("session_count", 0) + 1
            session_id = f"S{n:02d}"
            self.storage.buffer_metadata(
                self.instance_id, patch={"session_count": n}
            )

        self.session_id = session_id
        self.session_episode_count = 0
        return session_id

    def write_episode(
        self,
        episode: dict[str, Any],
        importance: Importance = Importance.HIGH,
        tier: str = "episodic",
        affect_signal: Optional[dict[str, Any]] = None,
    ) -> str:
        """
        Append an episode to the buffer of the active session.

        `affect_signal` is an opaque dict consumed only by AffectPlugin if
        present — the kernel never inspects its shape.
        """
        if self.session_id is None:
            raise MemoryOSError("start_session() must be called first")
        if self.session_episode_count >= self.config.max_episodes_per_session:
            raise MemoryOSError(
                f"session {self.session_id} reached max "
                f"{self.config.max_episodes_per_session} episodes"
            )

        # Validate
        result = self.validators.validate_episode(episode, importance)
        if not result.valid:
            if self.validation_mode == "strict":
                raise MemoryOSError(
                    "episode validation failed:\n  - "
                    + "\n  - ".join(result.errors)
                )

        # Optional affect metadata
        if affect_signal is not None and self.affect is not None:
            episode = self.affect.attach_affect_metadata(episode, affect_signal)

        # Apply write policy (e.g. EVA's L1/L2/L3 stripping)
        shaped = self.write_policy.filter_for_write(episode, importance)

        # Stamp kernel metadata
        episode_id = shaped.get("episode_id") or self._make_episode_id()
        shaped["episode_id"] = episode_id
        shaped["_meta"] = {
            **shaped.get("_meta", {}),
            "instance_id": self.instance_id,
            "session_id": self.session_id,
            "importance": importance.value,
            "written_at": _now(),
        }

        # Append into the buffer container for this tier
        self.storage.buffer_append(
            self.instance_id,  # type: ignore[arg-type]
            tier,
            container_key="episodes",
            item=shaped,
        )
        self.session_episode_count += 1
        return episode_id

    def write_semantic(
        self,
        concept: str,
        definition: str,
        episode_id: str,
        confidence: float = 0.3,
        epistemic_status: str = "hypothesis",
        extra: Optional[dict[str, Any]] = None,
    ) -> str:
        if self.session_id is None:
            raise MemoryOSError("start_session() must be called first")

        # Read existing for conflict detection
        existing = self.storage.buffer_load(
            self.instance_id,  # type: ignore[arg-type]
            "semantic",
            "entries",
        ).get("entries", [])

        proposal = {
            "concept": concept,
            "definition": definition,
            "derived_from": {"episode_id": episode_id},
            "confidence": confidence,
            "epistemic_status": epistemic_status,
            **(extra or {}),
        }

        result = self.validators.validate_semantic(proposal, existing)
        if not result.valid and self.validation_mode == "strict":
            raise MemoryOSError(
                "semantic validation failed:\n  - "
                + "\n  - ".join(result.errors)
            )
        if result.context.get("conflict_detected"):
            proposal["conflicts_with"] = [result.context["conflicting_concept"]]

        semantic_id = f"sem_{self.session_id}_{uuid.uuid4().hex[:8]}"
        proposal["semantic_id"] = semantic_id
        proposal["created_at"] = _now()
        proposal["last_updated"] = _now()

        self.storage.buffer_append(
            self.instance_id,  # type: ignore[arg-type]
            "semantic",
            container_key="entries",
            item=proposal,
        )
        return semantic_id

    def end_session(self) -> dict[str, Any]:
        """
        Close the session: snapshot it as a 'session' artefact, then
        evaluate consolidation cascades.
        """
        if self.session_id is None:
            raise MemoryOSError("no active session")

        # Build the session snapshot from buffer contents
        snapshot = self._gather_session_snapshot()
        self.storage.snapshot_save("session", self.session_id, snapshot)

        # Evaluate cascade
        triggered = self._evaluate_cascade(starting_tier="session")

        sid = self.session_id
        self.session_id = None
        self.session_episode_count = 0

        return {
            "session_id": sid,
            "episode_count": snapshot.get("episode_count", 0),
            "status": "ended",
            "cascade_triggered": triggered,
        }

    def _gather_session_snapshot(self) -> dict[str, Any]:
        episodic = self.storage.buffer_load(
            self.instance_id, "episodic", "episodes"  # type: ignore[arg-type]
        ).get("episodes", [])
        semantic = self.storage.buffer_load(
            self.instance_id, "semantic", "entries"  # type: ignore[arg-type]
        ).get("entries", [])
        return {
            "session_id": self.session_id,
            "instance_id": self.instance_id,
            "created_at": _now(),
            "episode_count": len(episodic),
            "episodes": episodic,
            "semantic_updates": semantic,
        }

    # ── 4. Consolidation cascade ────────────────────────────────────────

    def _evaluate_cascade(self, starting_tier: str) -> list[dict[str, Any]]:
        """
        Walk the configured cascade rules in order. Whenever the count of
        items in `from_tier` since the last fold reaches `every_n`, fold
        them and bubble up to the next rule.
        """
        triggered: list[dict[str, Any]] = []
        state = self.storage.get_version_state()

        for rule in self.config.consolidation_rules:
            if rule.from_tier != starting_tier:
                continue
            counter_key = f"count_since_last_{rule.to_tier}"
            state[counter_key] = state.get(counter_key, 0) + 1

            if state[counter_key] >= rule.every_n:
                snapshot_id = self._consolidate(rule)
                state[counter_key] = 0
                triggered.append({
                    "rule": f"{rule.from_tier}→{rule.to_tier}",
                    "snapshot_id": snapshot_id,
                })
                # Bubble: next iteration treats this tier as the new starting
                starting_tier = rule.to_tier

        self.storage.set_version_state(state)
        return triggered

    def _consolidate(self, rule: ConsolidationRule) -> str:
        """
        Fold the last N snapshots from `from_tier` into one snapshot in
        `to_tier`. The kernel's role is to gather + merge metadata; the
        actual semantic summarisation (key decisions, themes, etc.) is
        out-of-scope and would typically be done by an LLM step before
        end_session() — what we keep here is the cascade orchestration.
        """
        candidates = self.storage.snapshot_list(rule.from_tier)
        if not candidates:
            raise ConsolidationError(f"no {rule.from_tier} snapshots to fold")
        sources = candidates[-rule.every_n :]

        loaded = [self.storage.snapshot_load(rule.from_tier, sid) for sid in sources]

        state = self.storage.get_version_state()
        next_serial = state.get(f"{rule.to_tier}_serial", 0) + 1
        state[f"{rule.to_tier}_serial"] = next_serial
        self.storage.set_version_state(state)

        snapshot_id = f"{rule.to_tier[0].upper()}{next_serial:03d}"
        snapshot = {
            f"{rule.to_tier}_id": snapshot_id,
            "created_at": _now(),
            f"{rule.from_tier}_refs": [
                s.get(f"{rule.from_tier}_id") or s.get("session_id")
                for s in loaded
            ],
            "source_count": len(loaded),
            "total_episodes": sum(s.get("episode_count", 0) for s in loaded),
            # Aggregated payload — implementations can post-process.
            "aggregated_episodes": [
                e for s in loaded for e in s.get("episodes", [])
                if e.get("_meta", {}).get("importance", 0.0) >= Importance.HIGH.value
            ],
            "aggregated_semantic": [
                e for s in loaded for e in s.get("semantic_updates", [])
                if self.validators.is_consolidation_eligible(e)
            ],
            "metadata": {
                "consolidation_version": self._current_version(),
                "auto_triggered": True,
                "rule": f"{rule.from_tier}→{rule.to_tier} every {rule.every_n}",
            },
        }
        self.storage.snapshot_save(rule.to_tier, snapshot_id, snapshot)
        return snapshot_id

    # ── 5. Promote buffer → master (consolidate to origin) ──────────────

    def consolidate_to_origin(self) -> int:
        """
        Atomically promote the current instance's buffer to the master
        state. Pre-flight backup + post-write verification provided by
        StorageBackend.
        """
        if self.instance_id is None:
            raise MemoryOSError("no active instance")

        version = self._current_version()
        self.storage.master_backup(version)

        for tier in self.config.in_session_tiers:
            container = "episodes" if tier == "episodic" else "entries"
            buffer_data = self.storage.buffer_load(
                self.instance_id, tier, container
            )
            master = self.storage.master_load(tier)
            merged = self._merge_buffer_into_master(tier, master, buffer_data)
            self.storage.master_save(tier, merged)

        new_version = version + 1
        state = self.storage.get_version_state()
        state["version"] = new_version
        state["updated_at"] = _now()
        self.storage.set_version_state(state)

        self.storage.buffer_delete(self.instance_id)
        self.instance_id = None
        return new_version

    def _merge_buffer_into_master(
        self, tier: str, master: dict[str, Any], buffer_data: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Default merge strategy:
          • episodic: append-only
          • semantic: dedupe-by-concept, keep highest-confidence; only
            entries that pass is_consolidation_eligible() are merged
          • everything else: append-only

        Override by subclassing if you want different semantics per tier.
        """
        if tier == "episodic":
            episodes = list(master.get("episodes", []))
            episodes.extend(buffer_data.get("episodes", []))
            return {**master, "episodes": episodes, "timestamp": _now()}

        if tier == "semantic":
            existing = {e["concept"]: e for e in master.get("entries", [])}
            for e in buffer_data.get("entries", []):
                if not self.validators.is_consolidation_eligible(e):
                    continue
                concept = e.get("concept")
                if not concept:
                    continue
                prior = existing.get(concept)
                if prior is None or e.get("confidence", 0) > prior.get("confidence", 0):
                    existing[concept] = e
            return {**master, "entries": list(existing.values())}

        # generic append
        entries = list(master.get("entries", []))
        entries.extend(buffer_data.get("entries", []))
        return {**master, "entries": entries}

    # ── helpers ─────────────────────────────────────────────────────────

    def _current_version(self) -> int:
        return self.storage.get_version_state().get("version", 1)

    def _make_episode_id(self) -> str:
        return f"ep_{self.session_id}_{self.session_episode_count + 1:03d}_{uuid.uuid4().hex[:6]}"
