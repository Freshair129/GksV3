"""
Default WritePolicy + ValidatorChain — paradigm-agnostic implementations
that the kernel uses when no plugin is supplied. These are deliberately
minimal: they make Memory OS work out of the box without forcing
EVA-specific semantics on every user.

Anything more opinionated (RI-levels, RMS scoring, eva_matrix shape) goes
in eva/eva_plugin.py.
"""

from __future__ import annotations

from typing import Any

from .interfaces import (
    Importance,
    ValidationResult,
    ValidatorChain,
    WritePolicy,
)


class PassThroughWritePolicy:
    """
    Default: keep the episode whole regardless of importance. Importance
    is recorded in metadata for downstream queries / aggregation, but the
    payload itself isn't trimmed.

    Implementations that want EVA-style "L1 = strip body" behaviour should
    override this. See eva/eva_plugin.py:RiLevelWritePolicy.
    """

    def filter_for_write(
        self, episode: dict[str, Any], importance: Importance
    ) -> dict[str, Any]:
        out = dict(episode)
        meta = dict(out.get("_meta", {}))
        meta["importance"] = importance.value
        out["_meta"] = meta
        return out


class MinimalValidatorChain:
    """
    Default validators: only enforce structural minimums that the kernel
    relies on. Real systems should plug in proper schema validators.
    """

    def validate_episode(
        self, episode: dict[str, Any], importance: Importance
    ) -> ValidationResult:
        if not isinstance(episode, dict):
            return ValidationResult(False, ["episode must be a dict"])
        return ValidationResult(True)

    def validate_semantic(
        self, entry: dict[str, Any], existing_entries: list[dict[str, Any]]
    ) -> ValidationResult:
        if "concept" not in entry or "definition" not in entry:
            return ValidationResult(
                False,
                ["semantic entry requires 'concept' and 'definition'"],
            )
        # Surface conflicts but don't reject — the kernel records them as
        # `conflicts_with` so reviewers can adjudicate.
        ctx: dict[str, Any] = {}
        for ex in existing_entries:
            if ex.get("concept") == entry["concept"]:
                ctx["conflict_detected"] = True
                ctx["conflicting_concept"] = ex["concept"]
                break
        return ValidationResult(True, context=ctx)

    def validate_sensory(self, entry: dict[str, Any]) -> ValidationResult:
        return ValidationResult(isinstance(entry, dict))

    def is_consolidation_eligible(self, entry: dict[str, Any]) -> bool:
        # Default: anything with confidence > 0.7 (matches EVA's threshold);
        # missing confidence means "not yet evaluated" → skip.
        conf = entry.get("confidence")
        return isinstance(conf, (int, float)) and conf > 0.7


# Static singletons for convenience.
DEFAULT_WRITE_POLICY: WritePolicy = PassThroughWritePolicy()
DEFAULT_VALIDATOR_CHAIN: ValidatorChain = MinimalValidatorChain()
