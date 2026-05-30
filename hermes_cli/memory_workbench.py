"""Read-only dashboard Memory Workbench graph/search helpers.

This module deliberately keeps the dashboard API glue out of the indexing logic.
It normalizes Hermes hot memory, Honcho metadata, and LLM Wiki markdown into a
single graph shape suitable for an Obsidian-style dashboard page.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

from hermes_cli.honcho_memory_api import HonchoMemoryAPI, sanitize_metadata
from hermes_cli.memory_sources import MemorySourceRegistry, ProfileRecord

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")


class MemoryWorkbench:
    """Build read-only memory overview/search/graph data for the dashboard."""

    def __init__(self, root: Path | str | None = None):
        self.sources = MemorySourceRegistry(root)
        self.root = self.sources.root

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def list_profiles(self) -> list[dict[str, Any]]:
        return [self._profile_to_dict(profile) for profile in self.sources.discover_profiles()]

    def build_overview(self) -> dict[str, Any]:
        graph = self.build_graph(include_messages=False, include_raw_sources=True)
        return {
            "profiles": self.list_profiles(),
            "summary": graph["summary"],
            "warnings": graph.get("warnings", []),
        }

    def build_graph(
        self,
        *,
        profiles: str | Iterable[str] = "all",
        include_messages: bool = False,
        include_raw_sources: bool = True,
        include_derived_edges: bool = True,
    ) -> dict[str, Any]:
        selected = self.sources.select_profiles(profiles)
        nodes: dict[str, dict[str, Any]] = {}
        edges: dict[str, dict[str, Any]] = {}
        warnings: list[str] = []

        def add_node(node: dict[str, Any]) -> None:
            existing = nodes.get(node["id"])
            if existing is None:
                nodes[node["id"]] = node
                return
            if isinstance(existing.get("metadata"), dict) and isinstance(node.get("metadata"), dict):
                existing["metadata"] = {**existing["metadata"], **node["metadata"]}
            if node.get("summary"):
                existing["summary"] = node["summary"]
            existing["editable"] = bool(existing.get("editable")) or bool(node.get("editable"))

        def add_edge(edge: dict[str, Any]) -> None:
            edges.setdefault(edge["id"], edge)

        wiki_paths_seen: set[Path] = set()
        for profile in selected:
            profile_id = f"profile:{profile.name}"
            add_node({
                "id": profile_id,
                "source": "hermes",
                "kind": "profile",
                "label": profile.name,
                "editable": False,
                "metadata": {"path": str(profile.path), "is_default": profile.is_default},
            })
            self._add_hermes_memory(profile, profile_id, add_node, add_edge)
            self._add_honcho(profile, profile_id, add_node, add_edge, warnings, include_messages)

            if profile.wiki_path:
                wiki_root = profile.wiki_path.expanduser().resolve()
                if wiki_root not in wiki_paths_seen:
                    self._add_wiki(wiki_root, add_node, add_edge, warnings, include_raw_sources)
                    wiki_paths_seen.add(wiki_root)
                wiki_id = self._wiki_root_id(wiki_root)
                add_edge(self._edge(profile_id, wiki_id, "uses_wiki", "hermes"))

        if include_derived_edges:
            self._add_text_mention_edges(nodes, edges)

        node_list = list(nodes.values())
        edge_list = list(edges.values())
        return {
            "nodes": node_list,
            "edges": edge_list,
            "summary": {
                "profiles": len(selected),
                "nodes": len(node_list),
                "edges": len(edge_list),
                "hermes_entries": sum(1 for n in node_list if n["kind"] in {"hermes_user_entry", "hermes_memory_entry"}),
                "wiki_pages": sum(1 for n in node_list if n["kind"] == "wiki_page"),
                "honcho_nodes": sum(1 for n in node_list if n["source"] == "honcho"),
            },
            "warnings": warnings,
        }

    def search(self, query: str, *, profiles: str | Iterable[str] = "all", limit: int = 50) -> list[dict[str, Any]]:
        q = (query or "").strip().lower()
        if not q:
            return []
        graph = self.build_graph(profiles=profiles, include_messages=False, include_raw_sources=True)
        results: list[dict[str, Any]] = []
        for node in graph["nodes"]:
            hay = "\n".join(str(x) for x in [
                node.get("label", ""),
                node.get("summary", ""),
                node.get("metadata", {}).get("content", ""),
                node.get("metadata", {}).get("path", ""),
            ]).lower()
            if q not in hay:
                continue
            content = str(node.get("metadata", {}).get("content") or node.get("summary") or node.get("label") or "")
            results.append({
                "id": node["id"],
                "source": node["source"],
                "profile": node.get("metadata", {}).get("profile"),
                "kind": node["kind"],
                "title": node.get("label", node["id"]),
                "snippet": self._snippet(content, q),
                "editable": bool(node.get("editable", False)),
                "score": hay.count(q),
            })
        results.sort(key=lambda r: (-int(r.get("score") or 0), r["source"], r["title"]))
        return results[:limit]

    # ------------------------------------------------------------------
    # Hermes hot memory
    # ------------------------------------------------------------------
    def _add_hermes_memory(self, profile: ProfileRecord, profile_id: str, add_node, add_edge) -> None:
        specs = [("user", "USER.md", "hermes_user_entry"), ("memory", "MEMORY.md", "hermes_memory_entry")]
        for target, filename, kind in specs:
            path = profile.path / "memories" / filename
            entries = self.sources.read_memory_entries(path)
            store_id = f"hermes:{profile.name}:{target}"
            add_node({
                "id": store_id,
                "source": "hermes",
                "kind": f"hermes_{target}_store",
                "label": filename,
                "editable": False,
                "metadata": {"profile": profile.name, "path": str(path), "entry_count": len(entries)},
            })
            add_edge(self._edge(profile_id, store_id, "contains", "hermes"))
            for idx, entry in enumerate(entries):
                node_id = f"hermes:{profile.name}:{target}:{idx}"
                add_node({
                    "id": node_id,
                    "source": "hermes",
                    "kind": kind,
                    "label": self._short_label(entry),
                    "summary": entry,
                    "editable": True,
                    "metadata": {"profile": profile.name, "target": target, "index": idx, "path": str(path), "content": entry},
                })
                add_edge(self._edge(store_id, node_id, "contains", "hermes"))

    # ------------------------------------------------------------------
    # LLM Wiki
    # ------------------------------------------------------------------
    def _add_wiki(self, wiki_root: Path, add_node, add_edge, warnings: list[str], include_raw_sources: bool) -> None:
        if not wiki_root.is_dir():
            warnings.append(f"Wiki path does not exist: {wiki_root}")
            return
        root_id = self._wiki_root_id(wiki_root)
        add_node({
            "id": root_id,
            "source": "wiki",
            "kind": "wiki_root",
            "label": wiki_root.name or str(wiki_root),
            "editable": False,
            "metadata": {"path": str(wiki_root)},
        })
        page_by_stem: dict[str, str] = {}
        page_by_rel_no_ext: dict[str, str] = {}
        pages: list[tuple[Path, str, dict[str, Any], str]] = []
        for path in sorted(wiki_root.rglob("*.md")):
            try:
                rel = path.relative_to(wiki_root).as_posix()
            except ValueError:
                continue
            is_raw = rel.startswith("raw/")
            if is_raw and not include_raw_sources:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            fm, body = self.sources.split_frontmatter(text)
            title = str(fm.get("title") or path.stem.replace("-", " ").title())
            kind = "wiki_raw_source" if is_raw else "wiki_page"
            node_id = self._wiki_page_id(wiki_root, rel)
            pages.append((path, rel, fm, body))
            page_by_stem[path.stem.lower()] = node_id
            page_by_rel_no_ext[rel.removesuffix(".md").lower()] = node_id
            add_node({
                "id": node_id,
                "source": "wiki",
                "kind": kind,
                "label": title,
                "summary": self._short_label(body, 180),
                "editable": not is_raw,
                "metadata": {"path": str(path), "relative_path": rel, "content": body, "frontmatter": fm},
            })
            add_edge(self._edge(root_id, node_id, "contains", "wiki"))
            folder = str(Path(rel).parent)
            if folder and folder != ".":
                folder_id = f"wiki:{wiki_root}:folder:{folder}"
                add_node({"id": folder_id, "source": "wiki", "kind": "wiki_folder", "label": folder, "editable": False, "metadata": {"path": folder}})
                add_edge(self._edge(root_id, folder_id, "contains", "wiki"))
                add_edge(self._edge(folder_id, node_id, "folder_contains", "wiki"))
            for tag in self.sources.as_list(fm.get("tags")):
                tag_id = f"wiki-tag:{tag}"
                add_node({"id": tag_id, "source": "wiki", "kind": "wiki_tag", "label": str(tag), "editable": False, "metadata": {}})
                add_edge(self._edge(node_id, tag_id, "tagged", "wiki"))

        for _path, rel, fm, body in pages:
            node_id = self._wiki_page_id(wiki_root, rel)
            for source in self.sources.as_list(fm.get("sources")):
                source_rel = str(source).strip()
                target = page_by_rel_no_ext.get(source_rel.removesuffix(".md").lower())
                if target:
                    add_edge(self._edge(node_id, target, "cites_source", "wiki"))
            for link in _WIKILINK_RE.findall(body):
                norm = link.strip().removesuffix(".md").lower()
                target = page_by_rel_no_ext.get(norm) or page_by_stem.get(Path(norm).name)
                if target:
                    add_edge(self._edge(node_id, target, "wikilink", "wiki"))
                    add_edge(self._edge(target, node_id, "backlink", "wiki"))
                else:
                    missing_id = f"wiki-missing:{norm}"
                    add_node({"id": missing_id, "source": "wiki", "kind": "wiki_missing", "label": link.strip(), "editable": False, "metadata": {}})
                    add_edge(self._edge(node_id, missing_id, "broken_wikilink", "wiki"))

    def _wiki_root_id(self, wiki_root: Path) -> str:
        return f"wiki:{wiki_root}:root"

    def _wiki_page_id(self, wiki_root: Path, rel: str) -> str:
        return f"wiki:{wiki_root}:{rel}"

    # ------------------------------------------------------------------
    # Honcho
    # ------------------------------------------------------------------
    def _add_honcho(self, profile: ProfileRecord, profile_id: str, add_node, add_edge, warnings: list[str], include_messages: bool) -> None:
        cfg = profile.honcho_config or {}
        if not cfg:
            return
        honcho = HonchoMemoryAPI.from_config(profile.name, cfg)
        workspace = honcho.workspace
        workspace_id = f"honcho:{profile.name}:workspace:{workspace}"
        add_node({
            "id": workspace_id,
            "source": "honcho",
            "kind": "honcho_workspace",
            "label": workspace,
            "editable": False,
            "metadata": {"profile": profile.name, "base_url": honcho.safe_base_url, "workspace": workspace},
        })
        add_edge(self._edge(profile_id, workspace_id, "contains", "honcho"))
        for configured_peer_id in honcho.configured_peer_ids:
            peer_node_id = f"honcho:{profile.name}:peer:{configured_peer_id}"
            add_node({"id": peer_node_id, "source": "honcho", "kind": "honcho_peer", "label": configured_peer_id, "editable": True, "metadata": {"profile": profile.name, "peer_id": configured_peer_id}})
            add_edge(self._edge(workspace_id, peer_node_id, "contains", "honcho"))
        if not honcho.has_base_url:
            return
        peers = honcho.list_peers()
        warnings.extend(peers.warnings)
        for peer in peers.items:
            pid = str(peer.get("id") or peer.get("peer_id") or peer.get("name") or "").strip()
            if not pid:
                continue
            node_id = f"honcho:{profile.name}:peer:{pid}"
            add_node({"id": node_id, "source": "honcho", "kind": "honcho_peer", "label": pid, "editable": True, "metadata": {"profile": profile.name, "peer": sanitize_metadata(peer)}})
            add_edge(self._edge(workspace_id, node_id, "contains", "honcho"))
        conclusions = honcho.list_conclusions()
        warnings.extend(conclusions.warnings)
        for item in conclusions.items:
            cid = str(item.get("id") or item.get("uuid") or len(str(item)))
            text = str(item.get("content") or item.get("conclusion") or item.get("text") or item)
            node_id = f"honcho:{profile.name}:conclusion:{cid}"
            add_node({"id": node_id, "source": "honcho", "kind": "honcho_conclusion", "label": self._short_label(text), "summary": text, "editable": True, "metadata": {"profile": profile.name, "content": text, "raw": sanitize_metadata(item)}})
            add_edge(self._edge(workspace_id, node_id, "contains", "honcho"))
        if include_messages:
            # Message pagination varies across Honcho releases; keep the type in the schema but
            # do not risk expensive crawling until the user toggles it in a later editing phase.
            pass

    # ------------------------------------------------------------------
    # Derived edges/search helpers
    # ------------------------------------------------------------------
    def _add_text_mention_edges(self, nodes: dict[str, dict[str, Any]], edges: dict[str, dict[str, Any]]) -> None:
        labels = [(node_id, str(node.get("label", "")).lower()) for node_id, node in nodes.items() if len(str(node.get("label", ""))) >= 5]
        content_nodes = [(node_id, str(node.get("metadata", {}).get("content", node.get("summary", ""))).lower()) for node_id, node in nodes.items()]
        for source_id, content in content_nodes:
            if not content:
                continue
            for target_id, label in labels:
                if source_id == target_id or not label or label not in content:
                    continue
                edge = self._edge(source_id, target_id, "text_mentions", "derived")
                edges.setdefault(edge["id"], edge)

    def _profile_to_dict(self, profile: ProfileRecord) -> dict[str, Any]:
        return {
            "name": profile.name,
            "path": str(profile.path),
            "is_default": profile.is_default,
            "wiki_path": str(profile.wiki_path) if profile.wiki_path else None,
            "has_honcho": bool(profile.honcho_config),
        }

    @staticmethod
    def _edge(source: str, target: str, kind: str, edge_source: str) -> dict[str, Any]:
        return {"id": f"{source}->{kind}->{target}", "source": edge_source, "from": source, "to": target, "kind": kind}

    @staticmethod
    def _short_label(text: str, limit: int = 80) -> str:
        collapsed = re.sub(r"\s+", " ", text).strip()
        return collapsed if len(collapsed) <= limit else collapsed[: limit - 1].rstrip() + "…"

    @staticmethod
    def _snippet(text: str, query: str, radius: int = 80) -> str:
        lower = text.lower()
        idx = lower.find(query.lower())
        if idx < 0:
            return MemoryWorkbench._short_label(text, radius * 2)
        start = max(0, idx - radius)
        end = min(len(text), idx + len(query) + radius)
        prefix = "…" if start else ""
        suffix = "…" if end < len(text) else ""
        return prefix + text[start:end].strip() + suffix
