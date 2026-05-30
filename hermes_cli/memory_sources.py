"""Reusable source/profile helpers for the dashboard Memory Workbench.

This module is intentionally read-only.  It centralizes profile discovery,
source path resolution, and small parsing helpers so future source-specific write
adapters can reuse the same profile/path semantics without growing
``hermes_cli.memory_workbench``.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from hermes_constants import get_default_hermes_root

# Keep graph parsing aligned with tools.memory_tool.MemoryStore so graph entry
# indexes match the exact ID-addressed hot-memory editing API.
_ENTRY_DELIMITER = "\n§\n"
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


@dataclass(frozen=True)
class ProfileRecord:
    """Resolved Hermes profile metadata used by Memory Workbench sources."""

    name: str
    path: Path
    is_default: bool = False
    wiki_path: Path | None = None
    honcho_config: dict[str, Any] | None = None


class MemorySourceRegistry:
    """Read-only profile/source resolver shared by graph and future adapters."""

    def __init__(self, root: Path | str | None = None):
        self.root = Path(root).expanduser() if root is not None else get_default_hermes_root()

    def discover_profiles(self) -> list[ProfileRecord]:
        profiles: list[ProfileRecord] = []
        if self.root.is_dir():
            profiles.append(self.make_profile("default", self.root, True))
        profiles_root = self.root / "profiles"
        if profiles_root.is_dir():
            for item in sorted(profiles_root.iterdir(), key=lambda p: p.name):
                if item.is_dir() and _PROFILE_NAME_RE.match(item.name):
                    profiles.append(self.make_profile(item.name, item, False))
        return profiles

    def make_profile(self, name: str, path: Path, is_default: bool) -> ProfileRecord:
        return ProfileRecord(
            name=name,
            path=path,
            is_default=is_default,
            wiki_path=self.resolve_wiki_path(path),
            honcho_config=self.read_json(path / "honcho.json"),
        )

    def select_profiles(self, profiles: str | Iterable[str]) -> list[ProfileRecord]:
        discovered = self.discover_profiles()
        if profiles == "all":
            return discovered
        wanted = {p.strip() for p in profiles.split(",")} if isinstance(profiles, str) else {str(p).strip() for p in profiles}
        return [p for p in discovered if p.name in wanted]

    def resolve_wiki_path(self, profile_path: Path) -> Path | None:
        env = self.read_dotenv(profile_path / ".env")
        if env.get("WIKI_PATH"):
            return Path(env["WIKI_PATH"]).expanduser()
        cfg = self.read_yaml(profile_path / "config.yaml")
        for key in ("wiki_path", "llm_wiki_path"):
            if isinstance(cfg.get(key), str) and cfg[key].strip():
                return Path(cfg[key]).expanduser()
        wiki_cfg = cfg.get("wiki") if isinstance(cfg, dict) else None
        if isinstance(wiki_cfg, dict) and isinstance(wiki_cfg.get("path"), str):
            return Path(wiki_cfg["path"]).expanduser()
        default = Path(os.environ.get("WIKI_PATH", "") or str(Path.home() / "wiki")).expanduser()
        return default if default.exists() or profile_path == self.root else default

    @staticmethod
    def read_memory_entries(path: Path) -> list[str]:
        if not path.is_file():
            return []
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            return []
        parts = [part.strip() for part in text.split(_ENTRY_DELIMITER)]
        return [part for part in parts if part]

    @staticmethod
    def read_dotenv(path: Path) -> dict[str, str]:
        values: dict[str, str] = {}
        if not path.is_file():
            return values
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
        return values

    @staticmethod
    def read_json(path: Path) -> dict[str, Any] | None:
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    @staticmethod
    def read_yaml(path: Path) -> dict[str, Any]:
        if not path.is_file():
            return {}
        try:
            import yaml

            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
        match = _FRONTMATTER_RE.match(text)
        if not match:
            return {}, text
        body = text[match.end():]
        raw = match.group(1)
        try:
            import yaml

            data = yaml.safe_load(raw) or {}
            return (data if isinstance(data, dict) else {}), body
        except Exception:
            fm: dict[str, Any] = {}
            for line in raw.splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    fm[key.strip()] = value.strip()
            return fm, body

    @staticmethod
    def as_list(value: Any) -> list[Any]:
        if value is None:
            return []
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                return [p.strip().strip('"\'') for p in stripped[1:-1].split(",") if p.strip()]
            return [stripped] if stripped else []
        return [value]

    @staticmethod
    def extract_items(data: Any) -> list[dict[str, Any]]:
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        if isinstance(data, dict):
            for key in ("items", "results", "peers", "conclusions", "data"):
                value = data.get(key)
                if isinstance(value, list):
                    return [x for x in value if isinstance(x, dict)]
        return []
