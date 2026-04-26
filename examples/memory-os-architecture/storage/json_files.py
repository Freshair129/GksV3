"""
StorageBackend — local JSON files.

Mirrors MSP-v9.1's directory layout exactly so existing EVA installations
can flip to the layered architecture without touching their data:

    base_path/
      01_Episodic_memory/Episodic_memory.json
      02_Semantic_memory/Semantic_memory.json
      03_Sensory_memory/Sensory_memory.json
      04_Session_Memory/Session_memory_<id>.json
      05_Core_Memory/Core_memory_<id>.json
      06_Sphere_Memory/Sphere_memory_<id>.json
      07_User_block/User_Block.json
      Buffer/instance_<id>/01_Episodic_memory/...
      Backups/Origin_v<n>_<timestamp>/...
      version.json
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


# Tier name → directory mapping. Anything not in the map falls through
# to a generic "<tier>_memory" sibling — gives plugins a safe extension
# point without breaking EVA's numeric prefix convention.
_TIER_DIRS = {
    "episodic": "01_Episodic_memory",
    "semantic": "02_Semantic_memory",
    "sensory": "03_Sensory_memory",
    "session": "04_Session_Memory",
    "core": "05_Core_Memory",
    "sphere": "06_Sphere_Memory",
    "user_block": "07_User_block",
}

_TIER_MASTER_FILES = {
    "episodic": "Episodic_memory.json",
    "semantic": "Semantic_memory.json",
    "sensory": "Sensory_memory.json",
    "user_block": "User_Block.json",
}

_SNAPSHOT_PREFIXES = {
    "session": "Session_memory_",
    "core": "Core_memory_",
    "sphere": "Sphere_memory_",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    tmp.replace(path)


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError:
        return {}


class JsonFileStorage:
    """
    Default file-system StorageBackend. Replicates MSP-v9.1's on-disk
    layout — drop-in compatible.
    """

    def __init__(self, base_path: Path) -> None:
        self.base_path = Path(base_path)
        self.buffer_root = self.base_path / "Buffer"
        self.backup_root = self.base_path / "Backups"
        self.version_file = self.base_path / "version.json"

    # ── tier-name resolution ────────────────────────────────────────────

    def _tier_dir(self, tier: str) -> Path:
        return self.base_path / _TIER_DIRS.get(tier, f"{tier}_memory")

    def _instance_dir(self, instance_id: str) -> Path:
        return self.buffer_root / f"instance_{instance_id}"

    # ── buffer ──────────────────────────────────────────────────────────

    def buffer_init(self, instance_id: str, metadata: dict[str, Any]) -> None:
        path = self._instance_dir(instance_id)
        path.mkdir(parents=True, exist_ok=True)
        for tier in ("episodic", "semantic", "sensory"):
            (path / _TIER_DIRS[tier]).mkdir(parents=True, exist_ok=True)
        _atomic_write_json(path / "metadata.json", metadata)

    def buffer_metadata(
        self, instance_id: str, patch: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        path = self._instance_dir(instance_id) / "metadata.json"
        meta = _load_json(path)
        if patch:
            meta.update(patch)
            meta["updated_at"] = _now()
            _atomic_write_json(path, meta)
        return meta

    def buffer_append(
        self,
        instance_id: str,
        tier: str,
        container_key: str,
        item: dict[str, Any],
    ) -> None:
        path = (
            self._instance_dir(instance_id)
            / _TIER_DIRS.get(tier, f"{tier}_memory")
            / _TIER_MASTER_FILES.get(tier, f"{tier}.json")
        )
        data = _load_json(path)
        if container_key not in data:
            data = {
                "system": "memory_os",
                "instance_id": instance_id,
                "timestamp": _now(),
                container_key: [],
            }
        data[container_key].append(item)
        _atomic_write_json(path, data)

    def buffer_load(
        self, instance_id: str, tier: str, container_key: str
    ) -> dict[str, Any]:
        path = (
            self._instance_dir(instance_id)
            / _TIER_DIRS.get(tier, f"{tier}_memory")
            / _TIER_MASTER_FILES.get(tier, f"{tier}.json")
        )
        return _load_json(path)

    def buffer_save(
        self, instance_id: str, tier: str, container_key: str, data: dict[str, Any]
    ) -> None:
        path = (
            self._instance_dir(instance_id)
            / _TIER_DIRS.get(tier, f"{tier}_memory")
            / _TIER_MASTER_FILES.get(tier, f"{tier}.json")
        )
        _atomic_write_json(path, data)

    def buffer_delete(self, instance_id: str) -> None:
        path = self._instance_dir(instance_id)
        if path.exists():
            shutil.rmtree(path)

    # ── master ──────────────────────────────────────────────────────────

    def master_load(self, tier: str) -> dict[str, Any]:
        if tier not in _TIER_MASTER_FILES:
            return {}
        return _load_json(self._tier_dir(tier) / _TIER_MASTER_FILES[tier])

    def master_save(self, tier: str, data: dict[str, Any]) -> None:
        if tier not in _TIER_MASTER_FILES:
            raise ValueError(f"no master file for tier '{tier}'")
        _atomic_write_json(self._tier_dir(tier) / _TIER_MASTER_FILES[tier], data)

    def master_backup(self, version: int) -> str:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        target = self.backup_root / f"Origin_v{version}_{ts}"
        target.mkdir(parents=True, exist_ok=True)
        for tier, dirname in _TIER_DIRS.items():
            src = self.base_path / dirname
            if src.exists():
                shutil.copytree(src, target / dirname, dirs_exist_ok=True)
        _atomic_write_json(
            target / "backup_metadata.json",
            {"timestamp": _now(), "prev_version": version},
        )
        return str(target)

    # ── snapshots (session / core / sphere) ─────────────────────────────

    def snapshot_save(
        self, tier: str, snapshot_id: str, data: dict[str, Any]
    ) -> None:
        prefix = _SNAPSHOT_PREFIXES.get(tier, f"{tier}_")
        _atomic_write_json(
            self._tier_dir(tier) / f"{prefix}{snapshot_id}.json", data
        )

    def snapshot_load(self, tier: str, snapshot_id: str) -> dict[str, Any]:
        prefix = _SNAPSHOT_PREFIXES.get(tier, f"{tier}_")
        return _load_json(self._tier_dir(tier) / f"{prefix}{snapshot_id}.json")

    def snapshot_list(self, tier: str) -> list[str]:
        prefix = _SNAPSHOT_PREFIXES.get(tier, f"{tier}_")
        d = self._tier_dir(tier)
        if not d.exists():
            return []
        # Sort by mtime for deterministic "last N" picking.
        files = sorted(
            (p for p in d.glob(f"{prefix}*.json")),
            key=lambda p: p.stat().st_mtime,
        )
        return [p.stem.removeprefix(prefix) for p in files]

    # ── version ────────────────────────────────────────────────────────

    def get_version_state(self) -> dict[str, Any]:
        return _load_json(self.version_file) or {"version": 1}

    def set_version_state(self, state: dict[str, Any]) -> None:
        _atomic_write_json(self.version_file, state)
