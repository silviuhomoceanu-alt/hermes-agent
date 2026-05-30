"""Read-only dashboard Memory Workbench graph/search helpers.

This module deliberately keeps the dashboard API glue out of the indexing logic.
It normalizes Hermes hot memory, Honcho metadata, and LLM Wiki markdown into a
single graph shape suitable for an Obsidian-style dashboard page.
"""

from __future__ import annotations

import hashlib
import json
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
        view: str = "storage",
    ) -> dict[str, Any]:
        view = (view or "storage").strip().lower()
        if view not in {"storage", "stored_content"}:
            raise ValueError("memory graph view must be 'storage' or 'stored_content'")

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

        self._add_manual_links(selected, nodes, edges, warnings)

        if include_derived_edges:
            self._add_text_mention_edges(nodes, edges)

        node_list = list(nodes.values())
        edge_list = list(edges.values())
        result = {
            "view": view,
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
        if view == "stored_content":
            return self._stored_content_view(result)
        return result

    def _stored_content_view(self, graph: dict[str, Any]) -> dict[str, Any]:
        original_nodes = list(graph.get("nodes", []))
        original_edges = list(graph.get("edges", []))
        visible_ids = {
            str(node.get("id"))
            for node in original_nodes
            if self._is_stored_content_node(node)
        }
        nodes = [self._with_stored_content_provenance(node) for node in original_nodes if node.get("id") in visible_ids]
        edges = [
            edge for edge in original_edges
            if edge.get("from") in visible_ids
            and edge.get("to") in visible_ids
            and edge.get("kind") != "contains"
        ]
        summary = dict(graph.get("summary", {}))
        summary["storage_nodes"] = len(original_nodes)
        summary["storage_edges"] = len(original_edges)
        summary["nodes"] = len(nodes)
        summary["edges"] = len(edges)
        return {**graph, "nodes": nodes, "edges": edges, "summary": summary}

    @staticmethod
    def _is_stored_content_node(node: dict[str, Any]) -> bool:
        return node.get("kind") in {
            "hermes_user_entry",
            "hermes_memory_entry",
            "wiki_page",
            "wiki_raw_source",
            "honcho_peer",
            "honcho_conclusion",
        }

    def _with_stored_content_provenance(self, node: dict[str, Any]) -> dict[str, Any]:
        metadata = dict(node.get("metadata") or {})
        metadata["provenance"] = self._stored_content_provenance(node, metadata)
        return {**node, "metadata": metadata}

    @staticmethod
    def _stored_content_provenance(node: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
        source = str(node.get("source") or "")
        kind = str(node.get("kind") or "")
        if source == "hermes":
            target = str(metadata.get("target") or "")
            store = "USER.md" if target == "user" else "MEMORY.md" if target == "memory" else None
            provenance: dict[str, Any] = {
                "source": "hermes",
                "profile": metadata.get("profile"),
                "target": metadata.get("target"),
                "index": metadata.get("index"),
                "path": metadata.get("path"),
            }
            if store:
                provenance["store"] = store
            return provenance
        if source == "wiki":
            return {
                "source": "wiki",
                "kind": "raw_source" if kind == "wiki_raw_source" else "page",
                "path": metadata.get("path"),
                "relative_path": metadata.get("relative_path"),
            }
        if source == "honcho":
            raw_value = metadata.get("raw")
            raw: dict[str, Any] = raw_value if isinstance(raw_value, dict) else {}
            provenance = {
                "source": "honcho",
                "profile": metadata.get("profile"),
                "kind": "conclusion" if kind == "honcho_conclusion" else "peer",
            }
            if kind == "honcho_conclusion":
                provenance["id"] = raw.get("id") or raw.get("uuid") or str(node.get("id", "")).split(":")[-1]
            else:
                provenance["peer_id"] = metadata.get("peer_id") or raw.get("id") or raw.get("peer_id") or node.get("label")
            return provenance
        return {"source": source, "kind": kind}

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
    # Manual cross-store links
    # ------------------------------------------------------------------
    def link_nodes(
        self,
        profile: str,
        from_node_id: str,
        to_node_id: str,
        *,
        kind: str = "manual_link",
        label: str | None = None,
    ) -> dict[str, Any]:
        record = self._require_profile(profile)
        from_id = self._require_node_id(from_node_id, "fromNodeId")
        to_id = self._require_node_id(to_node_id, "toNodeId")
        edge_kind = self._normalize_manual_edge_kind(kind)
        link = {
            "id": self._manual_link_id(record.name, from_id, to_id, edge_kind),
            "profile": record.name,
            "from": from_id,
            "to": to_id,
            "kind": edge_kind,
        }
        if label and label.strip():
            link["label"] = label.strip()[:160]
        data = self._read_manual_links()
        links = self._profile_links(data, record.name)
        existing = next((item for item in links if item.get("id") == link["id"]), None)
        if existing:
            existing.update(link)
            saved = existing
        else:
            links.append(link)
            saved = link
        self._write_manual_links(data)
        return {"profile": record.name, "link": saved, "links": links}

    def unlink_nodes(
        self,
        profile: str,
        *,
        link_id: str | None = None,
        from_node_id: str | None = None,
        to_node_id: str | None = None,
        kind: str = "manual_link",
    ) -> dict[str, Any]:
        record = self._require_profile(profile)
        edge_kind = self._normalize_manual_edge_kind(kind)
        data = self._read_manual_links()
        links = self._profile_links(data, record.name)
        target_id = link_id.strip() if isinstance(link_id, str) and link_id.strip() else None
        if not target_id:
            if not from_node_id or not to_node_id:
                raise ValueError("unlink requires linkId or fromNodeId and toNodeId")
            target_id = self._manual_link_id(
                record.name,
                self._require_node_id(from_node_id, "fromNodeId"),
                self._require_node_id(to_node_id, "toNodeId"),
                edge_kind,
            )
        kept = [item for item in links if item.get("id") != target_id]
        removed = len(links) - len(kept)
        data.setdefault("profiles", {})[record.name] = kept
        self._write_manual_links(data)
        return {"profile": record.name, "removed": removed, "linkId": target_id, "links": kept}

    def _add_manual_links(self, profiles: list[ProfileRecord], nodes: dict[str, dict[str, Any]], edges: dict[str, dict[str, Any]], warnings: list[str]) -> None:
        data = self._read_manual_links()
        profile_names = {profile.name for profile in profiles}
        raw_profiles = data.get("profiles") if isinstance(data.get("profiles"), dict) else {}
        for profile_name in sorted(profile_names):
            raw_links = raw_profiles.get(profile_name, [])
            if not isinstance(raw_links, list):
                warnings.append(f"Manual links for profile {profile_name} are malformed")
                continue
            for item in raw_links:
                if not isinstance(item, dict):
                    continue
                from_id = str(item.get("from") or "")
                to_id = str(item.get("to") or "")
                kind = str(item.get("kind") or "manual_link")
                link_id = str(item.get("id") or self._manual_link_id(profile_name, from_id, to_id, kind))
                if from_id not in nodes or to_id not in nodes:
                    warnings.append(f"Manual link {link_id} references missing node(s)")
                    continue
                edges.setdefault(link_id, {
                    "id": link_id,
                    "source": "manual",
                    "from": from_id,
                    "to": to_id,
                    "kind": kind,
                    "metadata": {"profile": profile_name, "label": item.get("label")},
                })

    def _manual_links_path(self) -> Path:
        return self.root / "memory-workbench" / "links.json"

    def _read_manual_links(self) -> dict[str, Any]:
        path = self._manual_links_path()
        if not path.is_file():
            return {"version": 1, "profiles": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError(f"Invalid manual links file: {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"Invalid manual links file: {path}")
        if not isinstance(data.get("profiles"), dict):
            data["profiles"] = {}
        data.setdefault("version", 1)
        return data

    def _write_manual_links(self, data: dict[str, Any]) -> None:
        path = self._manual_links_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(path)

    @staticmethod
    def _profile_links(data: dict[str, Any], profile: str) -> list[dict[str, Any]]:
        profiles = data.setdefault("profiles", {})
        links = profiles.setdefault(profile, [])
        if not isinstance(links, list):
            raise ValueError(f"Manual links for profile {profile} are malformed")
        return links

    def _require_profile(self, profile: str) -> ProfileRecord:
        selected = self.sources.select_profiles(profile)
        if len(selected) != 1:
            raise ValueError(f"Expected exactly one profile, got: {profile}")
        return selected[0]

    @staticmethod
    def _require_node_id(node_id: str, field: str) -> str:
        value = (node_id or "").strip()
        if not value:
            raise ValueError(f"{field} is required")
        if len(value) > 500:
            raise ValueError(f"{field} is too long")
        return value

    @staticmethod
    def _normalize_manual_edge_kind(kind: str) -> str:
        value = (kind or "manual_link").strip().lower().replace("-", "_")
        if value not in {"manual_link", "curated_link"}:
            raise ValueError("Manual memory links support kind 'manual_link' or 'curated_link'")
        return value

    @staticmethod
    def _manual_link_id(profile: str, from_node_id: str, to_node_id: str, kind: str) -> str:
        digest = hashlib.sha256(f"{profile}\0{from_node_id}\0{to_node_id}\0{kind}".encode("utf-8")).hexdigest()[:16]
        return f"manual:{profile}:{kind}:{digest}"

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
