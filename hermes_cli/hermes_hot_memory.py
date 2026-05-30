"""Profile-aware Hermes hot-memory read/write helpers for the dashboard.

Writes intentionally go through ``tools.memory_tool.MemoryStore`` so the
Memory Workbench preserves the same locking, threat scanning, drift detection,
deduplication, and character-budget semantics as the agent-facing memory tool.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_cli.memory_sources import MemorySourceRegistry, ProfileRecord
from tools.memory_tool import ENTRY_DELIMITER, MemoryStore


class HermesHotMemory:
    """Read and mutate Hermes USER.md / MEMORY.md for a selected profile."""

    VALID_TARGETS = {"user", "memory"}

    def __init__(self, root: Path | str | None = None):
        self.sources = MemorySourceRegistry(root)

    def read(self, profile: str = "default") -> dict[str, Any]:
        record = self._profile(profile)
        stores: list[dict[str, Any]] = []
        with self._store_for(record) as store:
            for target in ("user", "memory"):
                entries = list(store._entries_for(target))
                path = store._path_for(target)
                char_limit = store._char_limit(target)
                used_chars = len(ENTRY_DELIMITER.join(entries)) if entries else 0
                stores.append({
                    "target": target,
                    "path": str(path),
                    "charLimit": char_limit,
                    "usedChars": used_chars,
                    "entries": [
                        {
                            "id": str(index),
                            "index": index,
                            "content": content,
                            "editable": True,
                        }
                        for index, content in enumerate(entries)
                    ],
                })
        return {"profile": record.name, "stores": stores, "warnings": []}

    def add(self, profile: str, target: str, content: str) -> dict[str, Any]:
        record = self._profile(profile)
        target = self._target(target)
        with self._store_for(record) as store:
            result = store.add(target, content)
        return self._response(record, result)

    def replace(self, profile: str, target: str, entry_id: str, expected_old_content: str, content: str) -> dict[str, Any]:
        record = self._profile(profile)
        target = self._target(target)
        with self._store_for(record) as store:
            result = store.replace_at(target, self._entry_index(entry_id), expected_old_content, content)
        return self._response(record, result)

    def remove(self, profile: str, target: str, entry_id: str, expected_old_content: str | None = None) -> dict[str, Any]:
        record = self._profile(profile)
        target = self._target(target)
        with self._store_for(record) as store:
            entries = list(store._entries_for(target))
            idx = self._entry_index(entry_id)
            if idx < 0 or idx >= len(entries):
                return self._response(record, {"success": False, "error": "Entry id is stale or invalid."})
            old_content = expected_old_content if expected_old_content is not None else entries[idx]
            result = store.remove_at(target, idx, old_content)
        return self._response(record, result)

    def _profile(self, name: str) -> ProfileRecord:
        selected = self.sources.select_profiles(name or "default")
        if not selected:
            raise ValueError(f"Unknown Hermes profile: {name}")
        if len(selected) != 1:
            raise ValueError(f"Expected exactly one profile, got: {name}")
        return selected[0]

    def _target(self, target: str) -> str:
        normalized = (target or "").strip().lower()
        if normalized not in self.VALID_TARGETS:
            raise ValueError("target must be 'user' or 'memory'")
        return normalized

    @contextmanager
    def _store_for(self, profile: ProfileRecord) -> Iterator[MemoryStore]:
        token = set_hermes_home_override(profile.path)
        try:
            store = MemoryStore()
            store.load_from_disk()
            yield store
        finally:
            reset_hermes_home_override(token)

    def _entry_index(self, entry_id: str) -> int:
        try:
            return int(entry_id)
        except (TypeError, ValueError):
            return -1

    def _response(self, profile: ProfileRecord, result: dict[str, Any]) -> dict[str, Any]:
        return {"profile": profile.name, **result}
