from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hermes_cli.wiki_memory import WikiMemory

pytestmark = pytest.mark.xdist_group("dashboard_auth_app_state")


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _fixture(root: Path, wiki: Path) -> None:
    _write(root / ".env", f"WIKI_PATH={wiki}\n")
    _write(wiki / "index.md", "---\ntitle: Home\n---\n# Home\n\nSee [[concepts/foo]] and [[entities/hermes]].\n")
    _write(
        wiki / "concepts" / "foo.md",
        "---\ntitle: Foo\ntags: [test]\nsources: [raw/source.md]\n---\n# Foo\n\nLinks to [[entities/hermes]] and [[missing-page]].\n",
    )
    _write(wiki / "entities" / "hermes.md", "---\ntitle: Hermes\n---\n# Hermes\n")
    _write(wiki / "raw" / "source.md", "# Raw Source\n")
    _write(wiki / "concepts" / "orphan.md", "---\ntitle: Orphan\n---\n# Orphan\n")
    _write(wiki / "concepts" / "nofm.md", "# No Frontmatter\n")
    _write(wiki / "concepts" / "bad-source.md", "---\ntitle: Bad Source\nsources: [../secret.md, docs/source.md]\n---\n# Bad\n")


def test_wiki_memory_tree_page_and_backlinks(tmp_path):
    root = tmp_path / ".hermes"
    wiki = tmp_path / "wiki"
    _fixture(root, wiki)

    api = WikiMemory(root=root)

    tree = api.tree("default")
    assert tree["profile"] == "default"
    assert tree["wiki_root"] == str(wiki.resolve())
    assert {page["path"] for page in tree["pages"]} >= {"index.md", "concepts/foo.md", "raw/source.md"}
    raw_page = next(page for page in tree["pages"] if page["path"] == "raw/source.md")
    assert raw_page["read_only"] is True

    page = api.page("default", "concepts/foo.md")
    assert page["title"] == "Foo"
    assert page["frontmatter"]["tags"] == ["test"]
    assert page["read_only"] is False
    assert {link["label"]: link["exists"] for link in page["outgoing_links"]} == {
        "entities/hermes": True,
        "missing-page": False,
    }
    assert [backlink["path"] for backlink in page["backlinks"]] == ["index.md"]

    raw = api.page("default", "raw/source.md")
    assert raw["read_only"] is True

    backlinks = api.backlinks("default", "entities/hermes")
    assert {backlink["path"] for backlink in backlinks["backlinks"]} == {"concepts/foo.md", "index.md"}


def test_wiki_memory_rejects_outside_root_page_paths(tmp_path):
    root = tmp_path / ".hermes"
    wiki = tmp_path / "wiki"
    _fixture(root, wiki)
    _write(tmp_path / "secret.md", "secret")

    api = WikiMemory(root=root)

    try:
        api.page("default", "../secret.md")
    except ValueError as exc:
        assert "outside the wiki root" in str(exc)
    else:
        raise AssertionError("outside-root page read should fail")


def test_wiki_memory_lint_reports_expected_issues(tmp_path):
    root = tmp_path / ".hermes"
    wiki = tmp_path / "wiki"
    _fixture(root, wiki)

    lint = WikiMemory(root=root).lint("default")
    issues = {(issue["kind"], issue["path"]) for issue in lint["issues"]}

    assert ("missing_frontmatter", "concepts/nofm.md") in issues
    assert ("broken_wikilink", "concepts/foo.md") in issues
    assert ("orphan_page", "concepts/orphan.md") in issues
    assert ("outside_root_source", "concepts/bad-source.md") in issues
    assert ("invalid_source_path", "concepts/bad-source.md") in issues
    assert lint["summary"]["errors"] >= 2
    assert lint["summary"]["warnings"] >= 2


def test_wiki_memory_lint_reports_outside_root_symlinks_without_reading_target(monkeypatch, tmp_path):
    root = tmp_path / ".hermes"
    wiki = tmp_path / "wiki"
    _fixture(root, wiki)
    outside = tmp_path / "secret.md"
    _write(outside, "secret outside content")
    link = wiki / "concepts" / "outside-link.md"
    link.symlink_to(outside)

    original_read_text = Path.read_text

    def guarded_read_text(self: Path, *args, **kwargs):
        if self.resolve() == outside.resolve():
            raise AssertionError("lint must not read outside-root symlink targets")
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", guarded_read_text)

    lint = WikiMemory(root=root).lint("default")
    assert ("outside_root_page", "concepts/outside-link.md") in {(issue["kind"], issue["path"]) for issue in lint["issues"]}


def test_wiki_memory_backlinks_rejects_missing_target(tmp_path):
    root = tmp_path / ".hermes"
    wiki = tmp_path / "wiki"
    _fixture(root, wiki)

    with pytest.raises(ValueError, match="Wiki page not found"):
        WikiMemory(root=root).backlinks("default", "missing-page")


def test_wiki_memory_dashboard_routes(monkeypatch, tmp_path):
    # Import inside the test so module-level route registration happens after the
    # direct WikiMemory tests above have no need for the heavy dashboard app.
    from hermes_cli import memory_sources, web_server

    root = tmp_path / ".hermes"
    wiki = tmp_path / "wiki"
    _fixture(root, wiki)
    monkeypatch.setattr(memory_sources, "get_default_hermes_root", lambda: root)

    prev_required = getattr(web_server.app.state, "auth_required", None)
    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_port = getattr(web_server.app.state, "bound_port", None)
    web_server.app.state.auth_required = False
    web_server.app.state.bound_host = "127.0.0.1"
    web_server.app.state.bound_port = 8080
    try:
        client = TestClient(web_server.app, base_url="http://127.0.0.1:8080")
        headers = {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}
        page = client.get("/api/memory/wiki/page", params={"profile": "default", "path": "concepts/foo.md"}, headers=headers)
        assert page.status_code == 200
        assert page.json()["title"] == "Foo"

        tree = client.get("/api/memory/wiki/tree", params={"profile": "default"}, headers=headers)
        assert tree.status_code == 200
        assert any(item["path"] == "concepts/foo.md" for item in tree.json()["pages"])

        lint = client.get("/api/memory/wiki/lint", params={"profile": "default"}, headers=headers)
        assert lint.status_code == 200
        assert lint.json()["summary"]["issues"] >= 1

        blocked = client.get("/api/memory/wiki/page", params={"profile": "default", "path": "../secret.md"}, headers=headers)
        assert blocked.status_code == 400
    finally:
        web_server.app.state.auth_required = prev_required
        web_server.app.state.bound_host = prev_host
        web_server.app.state.bound_port = prev_port
