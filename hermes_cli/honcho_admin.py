"""Controlled Honcho database admin helpers for the dashboard Memory Workbench.

This module intentionally exposes named operations only.  It does not accept
arbitrary SQL from the browser.  Honcho's public API currently has whole-session
and observation deletion paths, but no per-message admin cleanup endpoint; these
helpers cover local-admin cleanup with previews, dependent-row handling, backups,
and audit logs.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from hermes_constants import get_hermes_home


_MAX_LIMIT = 200
_DEFAULT_DB = "honcho"


def sql_literal(value: Any) -> str:
    """Return a PostgreSQL string literal for simple dashboard filters."""

    text = str(value)
    text = text.replace("\\", "\\\\").replace("'", "''")
    text = text.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f"'{text}'"


def _normalize_ids(ids: Iterable[Any]) -> list[int]:
    normalized: list[int] = []
    seen: set[int] = set()
    for raw in ids:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value <= 0 or value in seen:
            continue
        normalized.append(value)
        seen.add(value)
    return normalized


def _id_list_sql(ids: Iterable[Any]) -> str:
    values = _normalize_ids(ids)
    if not values:
        raise ValueError("At least one positive message id is required")
    return ",".join(str(v) for v in values)


@dataclass
class PsqlRunner:
    database: str = _DEFAULT_DB
    psql_path: str | None = None
    timeout: int = 30

    def __post_init__(self) -> None:
        if not self.psql_path:
            preferred = Path("/opt/homebrew/opt/postgresql@17/bin/psql")
            self.psql_path = str(preferred) if preferred.exists() else shutil.which("psql") or "psql"

    def query_json(self, query: str) -> list[dict[str, Any]]:
        wrapped = f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({query}) t;"
        cmd = [self.psql_path or "psql", "-d", self.database, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", wrapped]
        proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=self.timeout, check=False)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"psql exited {proc.returncode}")
        raw = proc.stdout.strip() or "[]"
        data = json.loads(raw)
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)]

    def execute(self, script: str) -> str:
        cmd = [self.psql_path or "psql", "-d", self.database, "-v", "ON_ERROR_STOP=1", "-q", "-c", script]
        proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=self.timeout, check=False)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"psql exited {proc.returncode}")
        return proc.stdout.strip()


class HonchoAdmin:
    """Named local Honcho admin operations used by the Memory Workbench."""

    def __init__(
        self,
        *,
        runner: Any | None = None,
        database: str = _DEFAULT_DB,
        backup_root: Path | None = None,
        audit_root: Path | None = None,
        pg_dump_path: str | None = None,
    ) -> None:
        self.database = database
        self.runner = runner or PsqlRunner(database=database)
        hermes_home = get_hermes_home()
        self.backup_root = backup_root or (hermes_home / "backups")
        self.audit_root = audit_root or (hermes_home / "memory-workbench" / "audits")
        preferred = Path("/opt/homebrew/opt/postgresql@17/bin/pg_dump")
        self.pg_dump_path = pg_dump_path or (str(preferred) if preferred.exists() else shutil.which("pg_dump") or "pg_dump")

    def list_messages(
        self,
        *,
        search: str = "",
        session: str = "",
        peer: str = "",
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit or 50), _MAX_LIMIT))
        safe_offset = max(0, int(offset or 0))
        where = self._message_where(search=search, session=session, peer=peer)
        where_sql = f"WHERE {' AND '.join(where)}" if where else ""
        total_rows = self.runner.query_json(f"SELECT count(*) AS total FROM messages {where_sql}")
        total = int((total_rows[0] if total_rows else {}).get("total") or 0)
        items = self.runner.query_json(
            f"""
            SELECT id, public_id, created_at, peer_name, workspace_name, session_name,
                   token_count,
                   left(regexp_replace(coalesce(content,''), '[[:space:]]+', ' ', 'g'), 500) AS content_preview,
                   content,
                   metadata,
                   internal_metadata
            FROM messages
            {where_sql}
            ORDER BY id DESC
            LIMIT {safe_limit} OFFSET {safe_offset}
            """
        )
        return {"items": items, "total": total, "limit": safe_limit, "offset": safe_offset}

    def _message_where(self, *, search: str = "", session: str = "", peer: str = "") -> list[str]:
        where: list[str] = []
        if search.strip():
            pattern = f"%{search.strip()}%"
            lit = sql_literal(pattern)
            where.append(f"(content ILIKE {lit} OR session_name ILIKE {lit} OR peer_name ILIKE {lit})")
        if session.strip():
            where.append(f"session_name = {sql_literal(session.strip())}")
        if peer.strip():
            where.append(f"peer_name = {sql_literal(peer.strip())}")
        return where

    def preview_delete_messages(self, message_ids: Iterable[Any]) -> dict[str, Any]:
        ids = _normalize_ids(message_ids)
        if not ids:
            raise ValueError("At least one positive message id is required")
        id_sql = _id_list_sql(ids)
        rows = self.runner.query_json(
            f"""
            SELECT
              (SELECT count(*) FROM message_embeddings WHERE message_id IN (SELECT public_id FROM messages WHERE id IN ({id_sql}))) AS message_embeddings,
              (SELECT count(*) FROM queue WHERE message_id IN (SELECT id FROM messages WHERE id IN ({id_sql}))) AS queue,
              (SELECT count(*) FROM messages WHERE id IN ({id_sql})) AS messages
            """
        )
        counts = rows[0] if rows else {"message_embeddings": 0, "queue": 0, "messages": 0}
        return {"message_ids": ids, "counts": {k: int(counts.get(k) or 0) for k in ("message_embeddings", "queue", "messages")}}

    def delete_messages(
        self,
        message_ids: Iterable[Any],
        *,
        confirm: bool = False,
        reason: str = "",
        create_backup: bool = True,
    ) -> dict[str, Any]:
        preview = self.preview_delete_messages(message_ids)
        if not confirm:
            return {**preview, "applied": False, "requiresConfirmation": True}
        backup_path = self._backup("delete-messages") if create_backup else None
        id_sql = _id_list_sql(preview["message_ids"])
        script = f"""
        BEGIN;
        DELETE FROM message_embeddings
        WHERE message_id IN (SELECT public_id FROM messages WHERE id IN ({id_sql}));
        DELETE FROM queue
        WHERE message_id IN (SELECT id FROM messages WHERE id IN ({id_sql}));
        DELETE FROM messages
        WHERE id IN ({id_sql});
        COMMIT;
        """
        self.runner.execute(script)
        audit_path = self._write_audit(
            "delete_messages",
            reason=reason,
            details={"message_ids": preview["message_ids"], "deleted": preview["counts"], "backup_path": str(backup_path) if backup_path else None},
        )
        return {"applied": True, "requiresConfirmation": False, "message_ids": preview["message_ids"], "deleted": preview["counts"], "backup_path": str(backup_path) if backup_path else None, "audit_path": str(audit_path)}

    def list_queue(self, *, processed: str = "", task_type: str = "", limit: int = 100, offset: int = 0) -> dict[str, Any]:
        safe_limit = max(1, min(int(limit or 100), _MAX_LIMIT))
        safe_offset = max(0, int(offset or 0))
        where: list[str] = []
        if processed in {"true", "false"}:
            where.append(f"processed = {processed}")
        if task_type.strip():
            where.append(f"task_type = {sql_literal(task_type.strip())}")
        where_sql = f"WHERE {' AND '.join(where)}" if where else ""
        total_rows = self.runner.query_json(f"SELECT count(*) AS total FROM queue {where_sql}")
        items = self.runner.query_json(
            f"""
            SELECT id, created_at, processed, task_type, work_unit_key, session_id, workspace_name, message_id,
                   error, left(coalesce(payload::text,''), 600) AS payload_preview
            FROM queue
            {where_sql}
            ORDER BY id DESC
            LIMIT {safe_limit} OFFSET {safe_offset}
            """
        )
        return {"items": items, "total": int((total_rows[0] if total_rows else {}).get("total") or 0), "limit": safe_limit, "offset": safe_offset}

    def delete_processed_queue(self, *, confirm: bool = False, reason: str = "", create_backup: bool = True) -> dict[str, Any]:
        count_rows = self.runner.query_json("SELECT count(*) AS total FROM queue WHERE processed = true")
        count = int((count_rows[0] if count_rows else {}).get("total") or 0)
        if not confirm:
            return {"applied": False, "requiresConfirmation": True, "deleted": {"queue": count}}
        backup_path = self._backup("delete-processed-queue") if create_backup else None
        self.runner.execute("BEGIN; DELETE FROM queue WHERE processed = true; COMMIT;")
        audit_path = self._write_audit("delete_processed_queue", reason=reason, details={"deleted": {"queue": count}, "backup_path": str(backup_path) if backup_path else None})
        return {"applied": True, "requiresConfirmation": False, "deleted": {"queue": count}, "backup_path": str(backup_path) if backup_path else None, "audit_path": str(audit_path)}

    def list_sessions(self) -> dict[str, Any]:
        items = self.runner.query_json(
            """
            SELECT s.id, s.name, s.workspace_name, s.is_active, s.created_at, s.metadata,
                   count(DISTINCT m.id) AS message_count,
                   count(DISTINCT q.id) AS queue_count,
                   count(DISTINCT d.id) AS document_count
            FROM sessions s
            LEFT JOIN messages m ON m.workspace_name = s.workspace_name AND m.session_name = s.name
            LEFT JOIN queue q ON q.session_id = s.id
            LEFT JOIN documents d ON d.workspace_name = s.workspace_name AND d.session_name = s.name
            GROUP BY s.id, s.name, s.workspace_name, s.is_active, s.created_at, s.metadata
            ORDER BY s.created_at DESC
            """
        )
        return {"items": items, "total": len(items)}

    def _backup(self, label: str) -> Path:
        self.backup_root.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = self.backup_root / f"honcho-before-{label}-{stamp}.sql"
        cmd = [self.pg_dump_path, self.database]
        with path.open("w", encoding="utf-8") as fh:
            proc = subprocess.run(cmd, text=True, stdout=fh, stderr=subprocess.PIPE, timeout=60, check=False)
        if proc.returncode != 0:
            try:
                path.unlink()
            except OSError:
                pass
            raise RuntimeError(proc.stderr.strip() or f"pg_dump exited {proc.returncode}")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return path

    def _write_audit(self, operation: str, *, reason: str, details: dict[str, Any]) -> Path:
        self.audit_root.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = self.audit_root / f"honcho-admin-{operation}-{stamp}.md"
        content = "\n".join(
            [
                f"# Honcho Admin: {operation}",
                "",
                f"- Timestamp: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
                f"- Reason: {reason or '(not supplied)'}",
                "",
                "```json",
                json.dumps(details, indent=2, ensure_ascii=False, sort_keys=True),
                "```",
                "",
            ]
        )
        path.write_text(content, encoding="utf-8")
        return path
