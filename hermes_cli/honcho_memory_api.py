"""Small Honcho API wrapper for the dashboard Memory Workbench.

The dashboard should treat Honcho as optional: local development often runs with
Honcho offline, and memory graph rendering must degrade to warnings instead of
raising.  This module centralizes config compatibility, timeouts, response item
normalization, and metadata sanitization so UI graph builders do not duplicate
Honcho quirks.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

_SECRET_KEY_RE = re.compile(r"(api[_-]?key|authorization|bearer|credential|password|secret|token)", re.IGNORECASE)
_DEFAULT_TIMEOUT_SECONDS = 0.7


@dataclass(frozen=True)
class HonchoAPIResult:
    """Normalized best-effort result from a Honcho endpoint."""

    items: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class HonchoMemoryAPI:
    """Profile-scoped Honcho client with config compatibility and timeouts."""

    profile: str
    base_url: str
    workspace: str = "hermes"
    peer_id: str = ""
    ai_peer_id: str = ""
    timeout: float = _DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_config(
        cls,
        profile: str,
        config: dict[str, Any] | None,
        *,
        timeout: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> "HonchoMemoryAPI":
        """Build a client from current camelCase or legacy snake_case config."""

        cfg = config or {}
        return cls(
            profile=profile,
            base_url=str(cfg.get("baseUrl") or cfg.get("base_url") or cfg.get("url") or "").strip().rstrip("/"),
            workspace=str(cfg.get("workspace") or "hermes").strip() or "hermes",
            peer_id=str(cfg.get("peerName") or cfg.get("peer_id") or cfg.get("peer") or "").strip(),
            ai_peer_id=str(cfg.get("aiPeer") or cfg.get("ai_peer") or "").strip(),
            timeout=timeout,
        )

    @property
    def has_base_url(self) -> bool:
        return bool(self.base_url)

    @property
    def safe_base_url(self) -> str:
        """Return a UI-safe base URL with userinfo, query, and fragment removed."""

        if not self.base_url:
            return ""
        parsed = urllib.parse.urlsplit(self.base_url)
        netloc = parsed.hostname or ""
        if parsed.port:
            netloc = f"{netloc}:{parsed.port}"
        return urllib.parse.urlunsplit((parsed.scheme, netloc, parsed.path.rstrip("/"), "", ""))

    @property
    def configured_peer_ids(self) -> list[str]:
        seen: set[str] = set()
        peers: list[str] = []
        for peer in (self.peer_id, self.ai_peer_id):
            if peer and peer not in seen:
                peers.append(peer)
                seen.add(peer)
        return peers

    def list_peers(self) -> HonchoAPIResult:
        return self._list_endpoint("peers", f"/v3/workspaces/{self.workspace}/peers/list", {})

    def list_conclusions(self) -> HonchoAPIResult:
        return self._list_endpoint("conclusions", f"/v3/workspaces/{self.workspace}/conclusions/list", {})

    def list_sessions(self) -> HonchoAPIResult:
        return self._list_endpoint("sessions", f"/v3/workspaces/{self.workspace}/sessions/list", {})

    def search(self, query: str, limit: int = 20) -> HonchoAPIResult:
        return self._list_endpoint("search", f"/v3/workspaces/{self.workspace}/search", {"query": query, "limit": limit})

    def update_peer_card(self, peer_id: str, card: list[str]) -> dict[str, Any]:
        if not self.base_url:
            raise RuntimeError("Honcho base URL is not configured")
        return self._post_json(f"/v3/workspaces/{self.workspace}/peers/{urllib.parse.quote(peer_id, safe='')}/card", {"card": card})

    def create_conclusion(self, peer_id: str, conclusion: str) -> dict[str, Any]:
        if not self.base_url:
            raise RuntimeError("Honcho base URL is not configured")
        return self._post_json(f"/v3/workspaces/{self.workspace}/peers/{urllib.parse.quote(peer_id, safe='')}/conclusions", {"conclusion": conclusion})

    def delete_conclusion(self, conclusion_id: str) -> dict[str, Any]:
        if not self.base_url:
            raise RuntimeError("Honcho base URL is not configured")
        return self._delete_json(f"/v3/workspaces/{self.workspace}/conclusions/{urllib.parse.quote(conclusion_id, safe='')}")

    def _list_endpoint(self, label: str, path: str, payload: dict[str, Any]) -> HonchoAPIResult:
        if not self.base_url:
            return HonchoAPIResult()
        try:
            data = self._post_json(path, payload)
            return HonchoAPIResult(items=extract_items(data))
        except Exception as exc:  # noqa: BLE001 - dashboard should fail soft
            return HonchoAPIResult(warnings=[f"Honcho {label} unavailable for profile {self.profile}: {exc}"])

    def _request_json(self, path: str, *, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
        data = json.dumps(payload or {}).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            raise RuntimeError(reason) from exc
        return json.loads(raw) if raw else {}

    def _post_json(self, path: str, payload: dict[str, Any]) -> Any:
        return self._request_json(path, method="POST", payload=payload)

    def _delete_json(self, path: str) -> Any:
        return self._request_json(path, method="DELETE")



def extract_items(data: Any) -> list[dict[str, Any]]:
    """Normalize common Honcho list response shapes to a list of dict items."""

    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("items", "results", "peers", "conclusions", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
    return []


def sanitize_metadata(value: Any) -> Any:
    """Recursively remove secret-looking fields before graph metadata reaches UI."""

    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            key_s = str(key)
            if _SECRET_KEY_RE.search(key_s):
                continue
            cleaned[key_s] = sanitize_metadata(item)
        return cleaned
    if isinstance(value, list):
        return [sanitize_metadata(item) for item in value]
    return value
