import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Database, RefreshCw, Search, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { api, type HonchoAdminDeleteResponse, type HonchoAdminMessage, type HonchoAdminQueueItem, type HonchoAdminSessionItem } from "@/lib/api";

type AdminTab = "messages" | "queue" | "sessions";

const PAGE_SIZE = 50;

export function HonchoAdminTable() {
  const [tab, setTab] = useState<AdminTab>("messages");
  const [search, setSearch] = useState("");
  const [session, setSession] = useState("");
  const [peer, setPeer] = useState("");
  const [messages, setMessages] = useState<HonchoAdminMessage[]>([]);
  const [queue, setQueue] = useState<HonchoAdminQueueItem[]>([]);
  const [sessions, setSessions] = useState<HonchoAdminSessionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectedMessage, setSelectedMessage] = useState<HonchoAdminMessage | null>(null);
  const [preview, setPreview] = useState<HonchoAdminDeleteResponse | null>(null);
  const [reason, setReason] = useState("Memory Workbench Honcho cleanup");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedArray = useMemo(() => [...selectedIds].sort((a, b) => a - b), [selectedIds]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    const run = tab === "messages"
      ? api.getHonchoAdminMessages({ search, session, peer, limit: PAGE_SIZE })
          .then((res) => { setMessages(res.items); setTotal(res.total); })
      : tab === "queue"
        ? api.getHonchoAdminQueue({ limit: PAGE_SIZE })
            .then((res) => { setQueue(res.items); setTotal(res.total); })
        : api.getHonchoAdminSessions()
            .then((res) => { setSessions(res.items); setTotal(res.total); });
    return run.catch((e: unknown) => setError(String(e))).finally(() => setLoading(false));
  }, [peer, search, session, tab]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refresh();
    }, tab === "messages" ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [refresh, tab]);

  const switchTab = (nextTab: AdminTab) => {
    setTab(nextTab);
    setSelectedIds(new Set());
    setPreview(null);
    setSelectedMessage(null);
  };

  const toggleSelected = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreview(null);
  };

  const previewDelete = () => {
    if (!selectedArray.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    api.previewDeleteHonchoMessages(selectedArray)
      .then(setPreview)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const deleteSelected = () => {
    if (!selectedArray.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    api.deleteHonchoMessages({ messageIds: selectedArray, reason, confirm: true, createBackup: true })
      .then((res) => {
        setNotice(`Deleted ${res.deleted?.messages ?? 0} messages. Backup: ${res.backup_path ?? "n/a"}`);
        setSelectedIds(new Set());
        setPreview(null);
        refresh();
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const deleteProcessedQueue = () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    api.deleteHonchoProcessedQueue({ reason, confirm: true, createBackup: true })
      .then((res) => {
        setNotice(`Deleted ${res.deleted?.queue ?? 0} processed queue rows. Backup: ${res.backup_path ?? "n/a"}`);
        refresh();
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="rounded-xl border border-border/60 bg-background/70 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-foreground/40">Honcho Admin</p>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Database className="h-4 w-4 text-midground" /> Records table
          </h2>
          <p className="mt-1 text-xs text-foreground/50">Search, inspect, and safely delete Honcho PostgreSQL records. Destructive actions create backups and audit logs.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TabButton active={tab === "messages"} onClick={() => switchTab("messages")}>Messages</TabButton>
          <TabButton active={tab === "queue"} onClick={() => switchTab("queue")}>Queue</TabButton>
          <TabButton active={tab === "sessions"} onClick={() => switchTab("sessions")}>Sessions</TabButton>
          <Button ghost size="sm" onClick={refresh} disabled={loading || busy}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {error && <div className="m-4 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {notice && <div className="m-4 rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}

      {tab === "messages" && (
        <div className="space-y-4 p-4">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_160px_160px_auto]">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-foreground/35" />
              <input className="w-full rounded-md border border-border/70 bg-background px-9 py-2 text-sm outline-none focus:border-midground" placeholder="Search content, session, peer" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <input className="rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none focus:border-midground" placeholder="Session" value={session} onChange={(e) => setSession(e.target.value)} />
            <input className="rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none focus:border-midground" placeholder="Peer" value={peer} onChange={(e) => setPeer(e.target.value)} />
            <Button size="sm" onClick={previewDelete} disabled={!selectedArray.length || busy}>Preview delete</Button>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 h-4 w-4" /> Raw message deletes remove dependent queue + embedding rows. Use curated wiki/Hermes memory for corrections; use delete for garbage/preflight rows.</div>
            <div className="font-mono">{selectedArray.length} selected / {total} total</div>
          </div>

          {preview && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <div className="font-semibold text-destructive">Delete preview</div>
              <div className="mt-1 text-xs text-foreground/70">Messages: {preview.counts?.messages ?? 0} · Queue: {preview.counts?.queue ?? 0} · Embeddings: {preview.counts?.message_embeddings ?? 0}</div>
              <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                <input className="rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none focus:border-midground" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cleanup reason" />
                <Button size="sm" onClick={deleteSelected} disabled={busy}><Trash2 className="h-3.5 w-3.5 text-destructive" /> Delete selected with backup</Button>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-border/60">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/30 text-foreground/50">
                <tr><th className="w-10 p-2"></th><th className="p-2">ID</th><th className="p-2">Created</th><th className="p-2">Session</th><th className="p-2">Peer</th><th className="p-2">Content</th><th className="p-2">Tokens</th></tr>
              </thead>
              <tbody>
                {messages.map((message) => (
                  <tr key={message.id} className="border-t border-border/40 hover:bg-muted/20">
                    <td className="p-2"><input type="checkbox" checked={selectedIds.has(message.id)} onChange={() => toggleSelected(message.id)} /></td>
                    <td className="p-2 font-mono text-foreground/70">{message.id}</td>
                    <td className="p-2 text-foreground/50">{formatDate(message.created_at)}</td>
                    <td className="p-2">{message.session_name}</td>
                    <td className="p-2">{message.peer_name}</td>
                    <td className="max-w-xl p-2"><button className="line-clamp-2 text-left text-foreground/80 hover:text-foreground" onClick={() => setSelectedMessage(message)}>{message.content_preview || message.content || "(empty)"}</button></td>
                    <td className="p-2 text-right font-mono text-foreground/50">{message.token_count ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedMessage && <RecordDetail message={selectedMessage} onClose={() => setSelectedMessage(null)} />}
        </div>
      )}

      {tab === "queue" && (
        <div className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-foreground/60">{total} queue rows shown newest first. Processed queue cleanup is the safest queue maintenance operation.</div>
            <Button size="sm" onClick={deleteProcessedQueue} disabled={busy}><Trash2 className="h-3.5 w-3.5 text-destructive" /> Delete processed queue with backup</Button>
          </div>
          <AdminTable headers={["ID", "Created", "Processed", "Task", "Message", "Error / payload"]} rows={queue.map((row) => [row.id, formatDate(row.created_at), String(row.processed ?? ""), row.task_type ?? "", row.message_id ?? "", row.error || row.payload_preview || ""])} />
        </div>
      )}

      {tab === "sessions" && (
        <div className="space-y-4 p-4">
          <div className="text-sm text-foreground/60">{total} sessions. Whole-session deletes should use Honcho's supported API path; this view is read-only for now.</div>
          <AdminTable headers={["ID", "Name", "Workspace", "Active", "Messages", "Queue", "Documents", "Created"]} rows={sessions.map((row) => [row.id, row.name, row.workspace_name ?? "", String(row.is_active ?? ""), row.message_count ?? 0, row.queue_count ?? 0, row.document_count ?? 0, formatDate(row.created_at)])} />
        </div>
      )}
    </section>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button onClick={onClick} className={`rounded-md px-3 py-1.5 text-sm transition ${active ? "bg-midground text-background" : "bg-muted/30 text-foreground/60 hover:text-foreground"}`}>{children}</button>;
}

function AdminTable({ headers, rows }: { headers: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/30 text-foreground/50"><tr>{headers.map((header) => <th className="p-2" key={header}>{header}</th>)}</tr></thead>
        <tbody>{rows.map((row, idx) => <tr key={idx} className="border-t border-border/40 hover:bg-muted/20">{row.map((cell, cidx) => <td className="max-w-xl truncate p-2" key={cidx}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function RecordDetail({ message, onClose }: { message: HonchoAdminMessage; onClose: () => void }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-4">
      <div className="mb-2 flex items-center justify-between"><div className="font-semibold">Message {message.id}</div><Button ghost size="sm" onClick={onClose}>Close</Button></div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-background p-3 text-xs text-foreground/80">{message.content || message.content_preview || ""}</pre>
      <details className="mt-3 text-xs"><summary className="cursor-pointer text-foreground/50">Raw metadata</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-background p-3">{JSON.stringify(message, null, 2)}</pre></details>
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
