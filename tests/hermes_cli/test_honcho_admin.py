from __future__ import annotations

import json
from pathlib import Path

from hermes_cli.honcho_admin import HonchoAdmin, sql_literal


class FakeRunner:
    def __init__(self):
        self.queries: list[str] = []
        self.scripts: list[str] = []

    def query_json(self, query: str):
        self.queries.append(query)
        if "count(*) AS total" in query:
            return [{"total": 2}]
        if "FROM messages" in query and "content_preview" in query:
            return [
                {"id": 3, "peer_name": "agent007", "session_name": "agent007", "content": "Smoke test"},
                {"id": 4, "peer_name": "hermes", "session_name": "agent007", "content": "STORED smoke"},
            ]
        if "message_embeddings" in query:
            return [{"message_embeddings": 1, "queue": 2, "messages": 2}]
        return []

    def execute(self, script: str):
        self.scripts.append(script)
        return "DELETE 2"


def test_sql_literal_escapes_quotes_and_control_chars():
    assert sql_literal("Silviu's\nthing") == "'Silviu''s\\nthing'"


def test_list_messages_builds_safe_filtered_query():
    runner = FakeRunner()
    admin = HonchoAdmin(runner=runner)

    result = admin.list_messages(search="smoke'test", session="agent007", peer="hermes", limit=500, offset=-10)

    assert result["total"] == 2
    assert len(result["items"]) == 2
    query = "\n".join(runner.queries)
    assert "ILIKE" in query
    assert "smoke''test" in query
    assert "session_name = 'agent007'" in query
    assert "peer_name = 'hermes'" in query
    assert "LIMIT 200" in query
    assert "OFFSET 0" in query


def test_preview_delete_messages_counts_dependents():
    runner = FakeRunner()
    admin = HonchoAdmin(runner=runner)

    preview = admin.preview_delete_messages([3, 4, 4, "bad", -1])

    assert preview["message_ids"] == [3, 4]
    assert preview["counts"] == {"message_embeddings": 1, "queue": 2, "messages": 2}
    assert "id IN (3,4)" in runner.queries[-1]


def test_delete_messages_requires_confirmation():
    runner = FakeRunner()
    admin = HonchoAdmin(runner=runner)

    result = admin.delete_messages([3, 4], confirm=False, reason="cleanup")

    assert result["applied"] is False
    assert result["requiresConfirmation"] is True
    assert runner.scripts == []


def test_delete_messages_deletes_dependents_before_messages_and_writes_audit(tmp_path: Path):
    runner = FakeRunner()
    admin = HonchoAdmin(runner=runner, audit_root=tmp_path, backup_root=tmp_path / "backups")

    result = admin.delete_messages([3, 4], confirm=True, reason="cleanup smoke tests", create_backup=False)

    assert result["applied"] is True
    assert result["deleted"] == {"message_embeddings": 1, "queue": 2, "messages": 2}
    script = runner.scripts[0]
    assert script.index("DELETE FROM message_embeddings") < script.index("DELETE FROM queue") < script.index("DELETE FROM messages")
    assert "id IN (3,4)" in script
    audit_path = Path(result["audit_path"])
    assert audit_path.exists()
    assert "cleanup smoke tests" in audit_path.read_text()


def test_delete_processed_queue_uses_processed_predicate(tmp_path: Path):
    runner = FakeRunner()
    admin = HonchoAdmin(runner=runner, audit_root=tmp_path, backup_root=tmp_path / "backups")

    result = admin.delete_processed_queue(confirm=True, reason="queue cleanup", create_backup=False)

    assert result["applied"] is True
    assert "DELETE FROM queue" in runner.scripts[0]
    assert "processed = true" in runner.scripts[0]


def test_list_sessions_includes_counts():
    runner = FakeRunner()
    admin = HonchoAdmin(runner=runner)
    def fake_query(query: str):
        runner.queries.append(query)
        return [{"name": "default", "message_count": 0, "queue_count": 0}]

    runner.query_json = fake_query  # type: ignore[method-assign]

    result = admin.list_sessions()

    assert result["items"][0]["name"] == "default"
    assert "LEFT JOIN messages" in runner.queries[0]
