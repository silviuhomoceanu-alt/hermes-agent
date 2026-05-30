from pathlib import Path

from hermes_cli.honcho_memory_api import HonchoMemoryAPI
from hermes_cli.memory_sources import MemorySourceRegistry
from hermes_cli.memory_workbench import MemoryWorkbench


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_memory_workbench_builds_unified_graph_from_profiles_and_wiki(tmp_path):
    root = tmp_path / ".hermes"
    default = root
    named = root / "profiles" / "research"
    wiki = tmp_path / "wiki"

    _write(default / "memories" / "USER.md", "Silviu prefers direct replies.\n§\nLives in Berlin.")
    _write(default / "memories" / "MEMORY.md", "Dashboard overlay branch is silviu-dashboard.")
    _write(default / ".env", f"WIKI_PATH={wiki}\n")
    _write(default / "honcho.json", '{"base_url":"http://127.0.0.1:9","workspace":"hermes","peer_id":"agent007"}')

    _write(named / "memories" / "USER.md", "Research profile user fact.")
    _write(named / "memories" / "MEMORY.md", "Research profile memory fact.")

    _write(wiki / "index.md", "# Index\n\n- [[concepts/memory-stack]]\n")
    _write(wiki / "concepts" / "memory-stack.md", "---\ntitle: Memory Stack\ntags: [memory, hermes]\nsources: [raw/articles/source.md]\n---\n# Memory Stack\nLinks to [[entities/hermes]] and [[missing-page]].\n")
    _write(wiki / "entities" / "hermes.md", "---\ntitle: Hermes\ntags: [agent]\n---\n# Hermes\n")
    _write(wiki / "raw" / "articles" / "source.md", "# Source")

    graph = MemoryWorkbench(root=root).build_graph(include_messages=False, include_raw_sources=True)

    node_ids = {node["id"] for node in graph["nodes"]}
    edge_kinds = {edge["kind"] for edge in graph["edges"]}

    assert "profile:default" in node_ids
    assert "profile:research" in node_ids
    assert "hermes:default:user:0" in node_ids
    assert "hermes:default:user:1" in node_ids
    assert "hermes:research:memory:0" in node_ids
    assert any(node["source"] == "wiki" and node["kind"] == "wiki_page" and node["label"] == "Memory Stack" for node in graph["nodes"])
    assert any(node["kind"] == "wiki_tag" and node["label"] == "memory" for node in graph["nodes"])
    assert any(node["kind"] == "wiki_raw_source" for node in graph["nodes"])
    assert "wikilink" in edge_kinds
    assert "tagged" in edge_kinds
    assert "cites_source" in edge_kinds
    assert graph["summary"]["profiles"] == 2
    assert graph["summary"]["hermes_entries"] == 5
    assert graph["summary"]["wiki_pages"] >= 3


def test_memory_workbench_accepts_current_honcho_camelcase_config(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    _write(root / "honcho.json", '{"baseUrl":"http://honcho.local","workspace":"hermes","peerName":"agent007","aiPeer":"hermes"}')

    def fake_post_json(_self, path, payload):
        assert _self.safe_base_url == "http://honcho.local"
        if path.endswith("/peers/list"):
            return {"items": [{"id": "agent007"}, {"id": "hermes"}]}
        if path.endswith("/conclusions/list"):
            return {"items": []}
        return {"items": []}

    monkeypatch.setattr(HonchoMemoryAPI, "_post_json", fake_post_json)

    graph = MemoryWorkbench(root=root).build_graph(include_messages=False, include_raw_sources=True)
    honcho_nodes = {node["id"]: node for node in graph["nodes"] if node["source"] == "honcho"}

    assert honcho_nodes["honcho:default:workspace:hermes"]["metadata"]["base_url"] == "http://honcho.local"
    assert "honcho:default:peer:agent007" in honcho_nodes
    assert "honcho:default:peer:hermes" in honcho_nodes
    assert graph["summary"]["honcho_nodes"] == 3


def test_memory_workbench_search_returns_merged_results(tmp_path):
    root = tmp_path / ".hermes"
    wiki = tmp_path / "wiki"
    _write(root / "memories" / "USER.md", "Silviu likes anti-fluff communication.")
    _write(root / ".env", f"WIKI_PATH={wiki}\n")
    _write(wiki / "concepts" / "communication.md", "---\ntitle: Communication\ntags: [memory]\n---\nAnti-fluff style notes.")

    workbench = MemoryWorkbench(root=root)
    results = workbench.search("anti-fluff")

    assert any(r["source"] == "hermes" and r["profile"] == "default" for r in results)
    assert any(r["source"] == "wiki" and r["title"] == "Communication" for r in results)
    assert all("anti-fluff" in r["snippet"].lower() for r in results)


def test_memory_source_registry_reuses_profile_resolution_helpers(tmp_path):
    root = tmp_path / ".hermes"
    named = root / "profiles" / "research"
    wiki = tmp_path / "wiki"
    ignored = root / "profiles" / "Invalid Name"

    _write(root / ".env", f"WIKI_PATH={wiki}\n")
    _write(named / "config.yaml", f"wiki:\n  path: {wiki / 'research'}\n")
    ignored.mkdir(parents=True)

    registry = MemorySourceRegistry(root=root)
    profiles = registry.discover_profiles()
    profile_names = [profile.name for profile in profiles]

    assert profile_names == ["default", "research"]
    assert profiles[0].wiki_path == wiki
    assert profiles[1].wiki_path == wiki / "research"
    assert [profile.name for profile in registry.select_profiles("research")] == ["research"]
