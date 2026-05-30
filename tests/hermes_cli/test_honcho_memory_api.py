import socket
import urllib.error
from fastapi.testclient import TestClient

from hermes_cli.honcho_memory_api import HonchoMemoryAPI, extract_items, sanitize_metadata
from hermes_cli.memory_workbench import MemoryWorkbench


def _write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_honcho_config_accepts_camelcase_and_sanitizes_base_url():
    api = HonchoMemoryAPI.from_config(
        "default",
        {
            "baseUrl": "http://user:pass@honcho.local:8000/api?token=secret#frag",
            "workspace": "memories",
            "peerName": "agent007",
            "aiPeer": "hermes",
        },
    )

    assert api.base_url == "http://user:pass@honcho.local:8000/api?token=secret#frag"
    assert api.safe_base_url == "http://honcho.local:8000/api"
    assert api.workspace == "memories"
    assert api.configured_peer_ids == ["agent007", "hermes"]


def test_honcho_config_accepts_legacy_snake_case_variants():
    api = HonchoMemoryAPI.from_config(
        "legacy",
        {
            "base_url": "http://127.0.0.1:8000/",
            "workspace": "hermes",
            "peer_id": "user-peer",
            "ai_peer": "ai-peer",
        },
    )

    assert api.base_url == "http://127.0.0.1:8000"
    assert api.peer_id == "user-peer"
    assert api.ai_peer_id == "ai-peer"


def test_honcho_list_endpoint_uses_timeout_and_normalizes_items(monkeypatch):
    calls = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"items":[{"id":"agent007"}]}'

    def fake_urlopen(request, timeout):
        calls.append((request.full_url, timeout))
        return FakeResponse()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    api = HonchoMemoryAPI.from_config("default", {"baseUrl": "http://honcho.local", "workspace": "hermes"}, timeout=0.12)

    result = api.list_peers()

    assert result.warnings == []
    assert result.items == [{"id": "agent007"}]
    assert calls == [("http://honcho.local/v3/workspaces/hermes/peers/list", 0.12)]


def test_honcho_offline_returns_warning_not_exception(monkeypatch):
    def fake_urlopen(_request, timeout):
        raise urllib.error.URLError(socket.timeout("timed out"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    api = HonchoMemoryAPI.from_config("default", {"baseUrl": "http://127.0.0.1:9"}, timeout=0.01)

    result = api.list_peers()

    assert result.items == []
    assert len(result.warnings) == 1
    assert "Honcho peers unavailable for profile default" in result.warnings[0]


def test_extract_items_accepts_common_honcho_shapes():
    assert extract_items([{"id": "a"}, "skip"]) == [{"id": "a"}]
    assert extract_items({"peers": [{"id": "a"}]}) == [{"id": "a"}]
    assert extract_items({"conclusions": [{"id": "c"}]}) == [{"id": "c"}]
    assert extract_items({"unknown": []}) == []


def test_sanitize_metadata_recursively_removes_secret_fields():
    clean = sanitize_metadata(
        {
            "id": "agent007",
            "api_key": "secret",
            "nested": {"accessToken": "secret", "content": "ok"},
            "items": [{"password": "secret", "value": 1}],
        }
    )

    assert clean == {"id": "agent007", "nested": {"content": "ok"}, "items": [{"value": 1}]}


def test_memory_workbench_uses_honcho_wrapper_and_never_exposes_secret_metadata(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    _write(
        root / "honcho.json",
        '{"baseUrl":"http://user:pass@honcho.local?token=secret","workspace":"hermes","peerName":"agent007","aiPeer":"hermes"}',
    )

    def fake_post_json(self, path, payload):
        if path.endswith("/peers/list"):
            return {"items": [{"id": "agent007", "api_key": "secret", "display": "Silviu"}]}
        if path.endswith("/conclusions/list"):
            return {"items": [{"id": "c1", "content": "Prefers direct replies", "authorization": "Bearer secret"}]}
        return {"items": []}

    monkeypatch.setattr(HonchoMemoryAPI, "_post_json", fake_post_json)

    graph = MemoryWorkbench(root=root).build_graph(include_messages=False, include_raw_sources=True)
    nodes = {node["id"]: node for node in graph["nodes"]}

    assert nodes["honcho:default:workspace:hermes"]["metadata"]["base_url"] == "http://honcho.local"
    assert nodes["honcho:default:peer:agent007"]["metadata"]["peer"] == {"id": "agent007", "display": "Silviu"}
    assert nodes["honcho:default:conclusion:c1"]["metadata"]["raw"] == {"id": "c1", "content": "Prefers direct replies"}
    assert graph["warnings"] == []



def test_honcho_dashboard_routes_read_write_and_confirmation(tmp_path, monkeypatch):
    from hermes_cli import memory_sources, web_server

    root = tmp_path / ".hermes"
    _write(root / "honcho.json", '{"baseUrl":"http://honcho.local","workspace":"hermes","peerName":"agent007","aiPeer":"hermes"}')
    monkeypatch.setattr(memory_sources, "get_default_hermes_root", lambda: root)

    calls = []

    def fake_post_json(self, path, payload):
        calls.append(("POST", path, payload))
        if path.endswith("/peers/list"):
            return {"items": [{"id": "agent007"}]}
        if path.endswith("/conclusions/list"):
            return {"items": [{"id": "c1", "content": "Existing"}]}
        if path.endswith("/sessions/list"):
            return {"items": [{"id": "s1"}]}
        if path.endswith("/search"):
            return {"items": [{"id": "hit"}]}
        return {"ok": True}

    def fake_delete_json(self, path):
        calls.append(("DELETE", path, None))
        return {"deleted": True}

    monkeypatch.setattr(HonchoMemoryAPI, "_post_json", fake_post_json)
    monkeypatch.setattr(HonchoMemoryAPI, "_delete_json", fake_delete_json)

    prev_required = getattr(web_server.app.state, "auth_required", None)
    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_port = getattr(web_server.app.state, "bound_port", None)
    web_server.app.state.auth_required = False
    web_server.app.state.bound_host = "127.0.0.1"
    web_server.app.state.bound_port = 8080
    try:
        client = TestClient(web_server.app, base_url="http://127.0.0.1:8080")
        headers = {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}

        status = client.get("/api/memory/honcho/status", params={"profile": "default"}, headers=headers)
        assert status.status_code == 200
        assert status.json()["peers"] == ["agent007", "hermes"]

        assert client.get("/api/memory/honcho/peers", params={"profile": "default"}, headers=headers).json()["peers"] == [{"id": "agent007"}]
        assert client.get("/api/memory/honcho/conclusions", params={"profile": "default"}, headers=headers).json()["conclusions"] == [{"id": "c1", "content": "Existing"}]
        assert client.get("/api/memory/honcho/sessions", params={"profile": "default"}, headers=headers).json()["sessions"] == [{"id": "s1"}]
        assert client.get("/api/memory/honcho/search", params={"profile": "default", "q": "direct"}, headers=headers).json()["results"] == [{"id": "hit"}]

        peer_card = client.put("/api/memory/honcho/peer-card", json={"profile": "default", "peerId": "agent007", "card": ["Prefers direct replies"]}, headers=headers)
        assert peer_card.status_code == 200
        create = client.post("/api/memory/honcho/conclusions", json={"profile": "default", "peerId": "agent007", "conclusion": "Prefers direct replies"}, headers=headers)
        assert create.status_code == 200
        delete_unconfirmed = client.delete("/api/memory/honcho/conclusions/c1", params={"profile": "default"}, headers=headers)
        assert delete_unconfirmed.status_code == 400
        delete = client.delete("/api/memory/honcho/conclusions/c1", params={"profile": "default", "confirm": "true"}, headers=headers)
        assert delete.status_code == 200

        assert ("POST", "/v3/workspaces/hermes/peers/list", {}) in calls
        assert ("POST", "/v3/workspaces/hermes/conclusions/list", {}) in calls
        assert ("POST", "/v3/workspaces/hermes/peers/agent007/card", {"card": ["Prefers direct replies"]}) in calls
        assert ("POST", "/v3/workspaces/hermes/peers/agent007/conclusions", {"conclusion": "Prefers direct replies"}) in calls
        assert ("DELETE", "/v3/workspaces/hermes/conclusions/c1", None) in calls
    finally:
        web_server.app.state.auth_required = prev_required
        web_server.app.state.bound_host = prev_host
        web_server.app.state.bound_port = prev_port


def test_honcho_dashboard_offline_status_warning(tmp_path, monkeypatch):
    from hermes_cli import memory_sources, web_server

    root = tmp_path / ".hermes"
    root.mkdir(parents=True, exist_ok=True)
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
        status = client.get("/api/memory/honcho/status", params={"profile": "default"}, headers=headers)
        assert status.status_code == 200
        assert status.json()["configured"] is False
        assert status.json()["warnings"]
        raw_edit = client.put("/api/memory/honcho/messages/m1", json={"content": "nope"}, headers=headers)
        assert raw_edit.status_code in {404, 405}
    finally:
        web_server.app.state.auth_required = prev_required
        web_server.app.state.bound_host = prev_host
        web_server.app.state.bound_port = prev_port
