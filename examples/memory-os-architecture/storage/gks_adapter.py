"""
StorageBackend — GKS via MCP (proof-of-concept stub).

Demonstrates how Memory OS would delegate persistence to GKS instead of
local JSON files. In production you would point this at a running
gks-mcp-server (started with `npx gks-mcp-server`) and use a real MCP
client (e.g. mcp[client] Python SDK).

Trade-offs vs JsonFileStorage:
  + multi-tenant (namespace-scoped)
  + queryable (recall over atomic + vector + episodic + obsidian)
  + audit log + observability + cost tracking out of the box
  + bi-temporal versioning per doc
  − network round-trips (mitigated by stdio MCP)
  − requires gks-mcp-server running

This stub uses an in-memory dict to stand in for the real GKS process
so the example is runnable without the actual server. Swap GksClient.call
for your MCP client of choice.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional, Protocol


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class GksClient(Protocol):
    """The minimum surface this adapter needs from your MCP client."""

    def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]: ...


class InMemoryGksClient:
    """
    Stand-in for testing / examples. Implements the same call() shape an
    MCP client would so you can wire in the real one later.
    """

    def __init__(self) -> None:
        self._store: dict[str, list[dict[str, Any]]] = {}
        self._meta: dict[str, dict[str, Any]] = {}

    def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        if tool == "gks_retain":
            ns = self._ns_key(args.get("namespace") or {})
            doc = {
                "id": args.get("path") or _now(),
                "content": args.get("content"),
                "metadata": args.get("metadata", {}),
                "namespace": args.get("namespace"),
                "valid_from": _now(),
                "valid_to": None,
            }
            self._store.setdefault(ns, []).append(doc)
            return {"ok": True, "doc_id": doc["id"]}

        if tool == "gks_recall":
            ns = self._ns_key(args.get("namespace") or {})
            hits = [
                {
                    "id": d["id"],
                    "snippet": (d.get("content") or "")[:120],
                    "metadata": d["metadata"],
                }
                for d in self._store.get(ns, [])
            ]
            return {"ok": True, "hits": hits[: args.get("topK", 5)]}

        if tool == "gks_lookup":
            for docs in self._store.values():
                for d in docs:
                    if d["id"] == args["id"]:
                        return {"ok": True, "found": True, "note": d}
            return {"ok": True, "found": False, "note": None}

        raise NotImplementedError(f"InMemoryGksClient.call: tool={tool!r}")

    @staticmethod
    def _ns_key(ns: dict[str, Any]) -> str:
        return "|".join(f"{k}={ns[k]}" for k in sorted(ns) if ns[k] is not None) or "_default"


class GksStorage:
    """
    Memory OS StorageBackend that persists everything through GKS's
    retain / recall / lookup MCP tools.

    Mapping:
      • each (instance_id, tier, container_key) → a GKS namespace:
          { tenant_id: 'memory_os', user_id: instance_id,
            session_id: tier, agent_id: container_key }
      • each item → one gks_retain call (its id stamped in metadata)
      • snapshot_save(tier='session', snapshot_id=...) → retain to namespace
        { tenant_id: 'memory_os', session_id: 'snapshots:'+tier }

    This keeps tenant-isolation honest: a non-EVA Memory OS instance can
    use the same GKS deployment without seeing EVA's data.
    """

    NAMESPACE_TENANT = "memory_os"

    def __init__(
        self,
        client: GksClient,
        instance_namespace: Optional[str] = None,
    ) -> None:
        self.gks = client
        self.instance_namespace = instance_namespace
        self._version_state: dict[str, Any] = {"version": 1}

    # ── helpers ─────────────────────────────────────────────────────────

    def _ns(
        self,
        instance_id: Optional[str] = None,
        tier: Optional[str] = None,
        container: Optional[str] = None,
    ) -> dict[str, Any]:
        ns: dict[str, Any] = {"tenant_id": self.NAMESPACE_TENANT}
        if instance_id:
            ns["user_id"] = instance_id
        if tier:
            ns["session_id"] = tier
        if container:
            ns["agent_id"] = container
        return ns

    # ── buffer ──────────────────────────────────────────────────────────

    def buffer_init(self, instance_id: str, metadata: dict[str, Any]) -> None:
        self.gks.call(
            "gks_retain",
            {
                "content": "[buffer init]",
                "namespace": self._ns(instance_id, "metadata", "init"),
                "metadata": {**metadata, "kind": "buffer_metadata"},
            },
        )

    def buffer_metadata(
        self, instance_id: str, patch: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        # In a real implementation we'd query for the latest metadata
        # doc; here we keep an in-memory shadow for simplicity.
        if patch:
            self.gks.call(
                "gks_retain",
                {
                    "content": "[buffer metadata patch]",
                    "namespace": self._ns(instance_id, "metadata", "patch"),
                    "metadata": {**patch, "kind": "buffer_metadata_patch"},
                },
            )
        result = self.gks.call(
            "gks_recall",
            {
                "query": "buffer_metadata",
                "namespace": self._ns(instance_id, "metadata"),
                "topK": 50,
            },
        )
        merged: dict[str, Any] = {}
        for h in result.get("hits", []):
            merged.update(h.get("metadata", {}))
        if patch:
            merged.update(patch)
        return merged

    def buffer_append(
        self,
        instance_id: str,
        tier: str,
        container_key: str,
        item: dict[str, Any],
    ) -> None:
        self.gks.call(
            "gks_retain",
            {
                "content": item.get("summary") or str(item.get("definition", "")),
                "namespace": self._ns(instance_id, tier, container_key),
                "metadata": {**item, "kind": "buffer_item"},
            },
        )

    def buffer_load(
        self, instance_id: str, tier: str, container_key: str
    ) -> dict[str, Any]:
        result = self.gks.call(
            "gks_recall",
            {
                "query": "*",
                "namespace": self._ns(instance_id, tier, container_key),
                "topK": 1000,
            },
        )
        items = [h.get("metadata", {}) for h in result.get("hits", [])]
        return {container_key: items}

    def buffer_save(
        self, instance_id: str, tier: str, container_key: str, data: dict[str, Any]
    ) -> None:
        # GKS is append-only; replacing in bulk requires a different
        # primitive (patchMetadataMany) — left as future work for the POC.
        raise NotImplementedError(
            "GksStorage.buffer_save is not supported on append-only GKS — "
            "use buffer_append per-item or extend with patchMetadataMany"
        )

    def buffer_delete(self, instance_id: str) -> None:
        # GKS doesn't expose hard-delete in MCP surface (correct: audit-trail
        # forbids it). We tombstone via metadata patch instead. For the POC
        # we just no-op.
        return

    # ── master ──────────────────────────────────────────────────────────

    def master_load(self, tier: str) -> dict[str, Any]:
        result = self.gks.call(
            "gks_recall",
            {
                "query": "*",
                "namespace": self._ns(None, f"master:{tier}", None),
                "topK": 1000,
            },
        )
        key = "episodes" if tier == "episodic" else "entries"
        return {key: [h.get("metadata", {}) for h in result.get("hits", [])]}

    def master_save(self, tier: str, data: dict[str, Any]) -> None:
        # Same caveat as buffer_save: GKS is append-only. A real adapter
        # would diff vs current state and call patchMetadataMany.
        for item in data.get("episodes", data.get("entries", [])):
            self.gks.call(
                "gks_retain",
                {
                    "content": item.get("summary") or str(item.get("definition", "")),
                    "namespace": self._ns(None, f"master:{tier}", None),
                    "metadata": {**item, "kind": f"master_{tier}"},
                },
            )

    def master_backup(self, version: int) -> str:
        # GKS's bi-temporal versioning gives us "free" backup: the master
        # state at any point can be reconstructed via valid_from/valid_to.
        # We just stamp a version marker.
        self.gks.call(
            "gks_retain",
            {
                "content": f"[master backup v{version}]",
                "namespace": self._ns(None, "backups", None),
                "metadata": {
                    "kind": "backup_marker",
                    "version": version,
                    "ts": _now(),
                },
            },
        )
        return f"gks://backup/v{version}"

    # ── snapshots ───────────────────────────────────────────────────────

    def snapshot_save(
        self, tier: str, snapshot_id: str, data: dict[str, Any]
    ) -> None:
        self.gks.call(
            "gks_retain",
            {
                "path": snapshot_id,
                "content": str(data.get("episode_count", "")),
                "namespace": self._ns(None, f"snapshots:{tier}", snapshot_id),
                "metadata": {**data, "kind": f"snapshot_{tier}"},
            },
        )

    def snapshot_load(self, tier: str, snapshot_id: str) -> dict[str, Any]:
        r = self.gks.call("gks_lookup", {"id": snapshot_id})
        if r.get("found"):
            note = r.get("note") or {}
            return note.get("metadata", {})
        return {}

    def snapshot_list(self, tier: str) -> list[str]:
        r = self.gks.call(
            "gks_recall",
            {
                "query": "*",
                "namespace": self._ns(None, f"snapshots:{tier}", None),
                "topK": 1000,
            },
        )
        return [h.get("id") for h in r.get("hits", []) if h.get("id")]

    # ── version ────────────────────────────────────────────────────────

    def get_version_state(self) -> dict[str, Any]:
        return dict(self._version_state)

    def set_version_state(self, state: dict[str, Any]) -> None:
        self._version_state = dict(state)
