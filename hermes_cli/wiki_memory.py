"""Read-only LLM Wiki page/tree/backlink/lint helpers for the dashboard.

The Memory Workbench graph is useful for overview/search, but the editor needs
structured page inputs.  This module keeps wiki path resolution, allowlisting,
frontmatter parsing, wikilink resolution, and linting out of ``web_server.py``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from hermes_cli.memory_sources import MemorySourceRegistry, ProfileRecord

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")


@dataclass(frozen=True)
class WikiPageRecord:
    path: Path
    rel: str
    frontmatter: dict[str, Any]
    body: str
    raw: str

    @property
    def is_raw(self) -> bool:
        return self.rel.startswith("raw/")

    @property
    def title(self) -> str:
        return str(self.frontmatter.get("title") or self.path.stem.replace("-", " ").title())


class WikiMemory:
    """Read-only structured adapter for a profile's configured LLM Wiki."""

    def __init__(self, root: Path | str | None = None):
        self.sources = MemorySourceRegistry(root)
        self.root = self.sources.root

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def tree(self, profile: str = "default") -> dict[str, Any]:
        profile_record, wiki_root = self._profile_and_root(profile)
        pages = self._pages(wiki_root)
        children: dict[str, dict[str, Any]] = {}
        root_node = {
            "id": "",
            "name": wiki_root.name or str(wiki_root),
            "path": "",
            "type": "directory",
            "children": [],
        }
        children[""] = root_node

        for page in pages:
            parts = page.rel.split("/")
            parent_key = ""
            for idx, part in enumerate(parts[:-1]):
                dir_key = "/".join(parts[: idx + 1])
                if dir_key not in children:
                    node = {"id": dir_key, "name": part, "path": dir_key, "type": "directory", "children": []}
                    children[dir_key] = node
                    children[parent_key]["children"].append(node)
                parent_key = dir_key
            children[parent_key]["children"].append(self._tree_page_node(page))

        self._sort_tree(root_node)
        return {
            "profile": profile_record.name,
            "wiki_root": str(wiki_root),
            "tree": root_node,
            "pages": [self._page_summary(page, wiki_root) for page in pages],
        }

    def page(self, profile: str = "default", path: str = "index.md") -> dict[str, Any]:
        profile_record, wiki_root = self._profile_and_root(profile)
        target = self._resolve_page_path(wiki_root, path)
        if not target.is_file():
            raise ValueError(f"Wiki page not found: {path}")
        record = self._read_page(target, wiki_root)
        pages = self._pages(wiki_root)
        return self._page_payload(profile_record.name, wiki_root, record, pages)

    def backlinks(self, profile: str = "default", path: str = "index.md") -> dict[str, Any]:
        profile_record, wiki_root = self._profile_and_root(profile)
        target = self._read_page(self._resolve_page_path(wiki_root, path), wiki_root)
        pages = self._pages(wiki_root)
        return {
            "profile": profile_record.name,
            "wiki_root": str(wiki_root),
            "path": target.rel,
            "backlinks": self._backlinks_for(target, pages, wiki_root),
        }

    def lint(self, profile: str = "default") -> dict[str, Any]:
        profile_record, wiki_root = self._profile_and_root(profile)
        pages = self._pages(wiki_root, include_outside=True)
        valid_pages = [page for page in pages if self._is_under_root(page.path, wiki_root)]
        page_by_rel, page_by_stem = self._page_indexes(valid_pages, wiki_root)
        inbound: dict[str, set[str]] = {page.rel: set() for page in valid_pages}
        issues: list[dict[str, Any]] = []

        for page in pages:
            if not self._is_under_root(page.path, wiki_root):
                issues.append(self._issue("outside_root_page", page.rel, "Page resolves outside the wiki root"))
                continue
            if not page.frontmatter and not page.is_raw:
                issues.append(self._issue("missing_frontmatter", page.rel, "Page has no YAML frontmatter"))
            for link in self._wikilinks(page.body):
                resolved = self._resolve_wikilink(link, page_by_rel, page_by_stem)
                if resolved is None:
                    issues.append(self._issue("broken_wikilink", page.rel, f"Broken wikilink: {link}", link=link))
                else:
                    inbound.setdefault(resolved.rel, set()).add(page.rel)
            for source in self.sources.as_list(page.frontmatter.get("sources")):
                source_text = str(source).strip()
                if not source_text:
                    continue
                source_path, outside = self._source_path(wiki_root, source_text)
                if outside:
                    issues.append(self._issue("outside_root_source", page.rel, f"Source path escapes wiki root: {source_text}", source=source_text))
                    continue
                if not source_text.startswith("raw/"):
                    issues.append(self._issue("invalid_source_path", page.rel, f"Source should live under raw/: {source_text}", source=source_text))
                if not source_path.is_file():
                    issues.append(self._issue("invalid_source_path", page.rel, f"Source file does not exist: {source_text}", source=source_text))

        for page in valid_pages:
            if page.is_raw or page.rel == "index.md" or Path(page.rel).name == "index.md":
                continue
            if not inbound.get(page.rel):
                issues.append(self._issue("orphan_page", page.rel, "Non-index page has no incoming wikilinks"))

        issues.sort(key=lambda item: (item["path"], item["kind"], item["message"]))
        return {
            "profile": profile_record.name,
            "wiki_root": str(wiki_root),
            "issues": issues,
            "summary": {
                "pages": len(valid_pages),
                "issues": len(issues),
                "errors": sum(1 for issue in issues if issue.get("severity") == "error"),
                "warnings": sum(1 for issue in issues if issue.get("severity") == "warning"),
            },
        }

    # ------------------------------------------------------------------
    # Profile/root and path safety
    # ------------------------------------------------------------------
    def _profile_and_root(self, profile_name: str) -> tuple[ProfileRecord, Path]:
        selected = self.sources.select_profiles(profile_name)
        if not selected:
            raise ValueError(f"Unknown Hermes profile: {profile_name}")
        if len(selected) != 1:
            raise ValueError(f"Expected exactly one profile, got: {profile_name}")
        profile = selected[0]
        if not profile.wiki_path:
            raise ValueError(f"Profile has no wiki path configured: {profile.name}")
        wiki_root = profile.wiki_path.expanduser().resolve()
        if not wiki_root.is_dir():
            raise ValueError(f"Wiki path does not exist: {wiki_root}")
        return profile, wiki_root

    def _resolve_page_path(self, wiki_root: Path, requested: str) -> Path:
        rel = (requested or "").strip().lstrip("/")
        if not rel:
            raise ValueError("Missing wiki page path")
        if rel.endswith("/"):
            rel += "index.md"
        if not rel.endswith(".md"):
            rel += ".md"
        target = (wiki_root / rel).resolve()
        if not self._is_under_root(target, wiki_root):
            raise ValueError(f"Wiki path is outside the wiki root: {requested}")
        try:
            target.relative_to(wiki_root)
        except ValueError as exc:
            raise ValueError(f"Wiki path is outside the wiki root: {requested}") from exc
        return target

    @staticmethod
    def _is_under_root(path: Path, wiki_root: Path) -> bool:
        try:
            path.resolve().relative_to(wiki_root.resolve())
            return True
        except ValueError:
            return False

    # ------------------------------------------------------------------
    # Page indexing/parsing
    # ------------------------------------------------------------------
    def _pages(self, wiki_root: Path, *, include_outside: bool = False) -> list[WikiPageRecord]:
        pages: list[WikiPageRecord] = []
        for path in sorted(wiki_root.rglob("*.md")):
            resolved = path.resolve()
            if not include_outside and not self._is_under_root(resolved, wiki_root):
                continue
            try:
                rel = path.relative_to(wiki_root).as_posix()
            except ValueError:
                rel = path.name
            pages.append(self._read_page(path, wiki_root, rel_override=rel))
        return pages

    def _read_page(self, path: Path, wiki_root: Path, *, rel_override: str | None = None) -> WikiPageRecord:
        if rel_override is None:
            rel = path.resolve().relative_to(wiki_root).as_posix()
        else:
            rel = rel_override
        raw = path.read_text(encoding="utf-8", errors="replace")
        frontmatter, body = self.sources.split_frontmatter(raw)
        return WikiPageRecord(path=path.resolve(), rel=rel, frontmatter=frontmatter, body=body, raw=raw)

    def _page_indexes(self, pages: Iterable[WikiPageRecord], wiki_root: Path) -> tuple[dict[str, WikiPageRecord], dict[str, WikiPageRecord]]:
        page_by_rel: dict[str, WikiPageRecord] = {}
        page_by_stem: dict[str, WikiPageRecord] = {}
        for page in pages:
            key = page.rel.removesuffix(".md").lower()
            page_by_rel[key] = page
            page_by_stem[page.path.stem.lower()] = page
        return page_by_rel, page_by_stem

    def _page_payload(self, profile: str, wiki_root: Path, record: WikiPageRecord, pages: list[WikiPageRecord]) -> dict[str, Any]:
        page_by_rel, page_by_stem = self._page_indexes(pages, wiki_root)
        outgoing = []
        for link in self._wikilinks(record.body):
            resolved = self._resolve_wikilink(link, page_by_rel, page_by_stem)
            outgoing.append({
                "label": link,
                "path": resolved.rel if resolved else None,
                "exists": resolved is not None,
            })
        return {
            "profile": profile,
            "wiki_root": str(wiki_root),
            "path": record.rel,
            "absolute_path": str(record.path),
            "title": record.title,
            "frontmatter": record.frontmatter,
            "body": record.body,
            "raw": record.raw,
            "read_only": record.is_raw,
            "outgoing_links": outgoing,
            "backlinks": self._backlinks_for(record, pages, wiki_root),
        }

    def _backlinks_for(self, target: WikiPageRecord, pages: Iterable[WikiPageRecord], wiki_root: Path) -> list[dict[str, Any]]:
        page_by_rel, page_by_stem = self._page_indexes(pages, wiki_root)
        backlinks: list[dict[str, Any]] = []
        for page in pages:
            if page.rel == target.rel:
                continue
            for link in self._wikilinks(page.body):
                resolved = self._resolve_wikilink(link, page_by_rel, page_by_stem)
                if resolved and resolved.rel == target.rel:
                    backlinks.append({"path": page.rel, "title": page.title, "link": link, "read_only": page.is_raw})
                    break
        backlinks.sort(key=lambda item: item["path"])
        return backlinks

    @staticmethod
    def _wikilinks(body: str) -> list[str]:
        return [match.strip() for match in _WIKILINK_RE.findall(body or "") if match.strip()]

    @staticmethod
    def _resolve_wikilink(link: str, page_by_rel: dict[str, WikiPageRecord], page_by_stem: dict[str, WikiPageRecord]) -> WikiPageRecord | None:
        norm = link.strip().removesuffix(".md").lower()
        return page_by_rel.get(norm) or page_by_stem.get(Path(norm).name)

    @staticmethod
    def _source_path(wiki_root: Path, source: str) -> tuple[Path, bool]:
        candidate = (wiki_root / source.strip().lstrip("/")).resolve()
        try:
            candidate.relative_to(wiki_root)
            return candidate, False
        except ValueError:
            return candidate, True

    # ------------------------------------------------------------------
    # Response helpers
    # ------------------------------------------------------------------
    def _page_summary(self, page: WikiPageRecord, wiki_root: Path) -> dict[str, Any]:
        return {
            "path": page.rel,
            "absolute_path": str(page.path),
            "title": page.title,
            "read_only": page.is_raw,
            "has_frontmatter": bool(page.frontmatter),
            "size_bytes": page.path.stat().st_size if page.path.exists() else 0,
        }

    def _tree_page_node(self, page: WikiPageRecord) -> dict[str, Any]:
        return {
            "id": page.rel,
            "name": Path(page.rel).name,
            "path": page.rel,
            "type": "page",
            "title": page.title,
            "read_only": page.is_raw,
            "has_frontmatter": bool(page.frontmatter),
        }

    def _sort_tree(self, node: dict[str, Any]) -> None:
        children = node.get("children") or []
        children.sort(key=lambda child: (child.get("type") != "directory", child.get("name", "")))
        for child in children:
            if child.get("type") == "directory":
                self._sort_tree(child)

    @staticmethod
    def _issue(kind: str, path: str, message: str, **extra: Any) -> dict[str, Any]:
        severity = "error" if kind in {"broken_wikilink", "outside_root_source", "outside_root_page"} else "warning"
        issue = {"kind": kind, "path": path, "message": message, "severity": severity}
        issue.update(extra)
        return issue
