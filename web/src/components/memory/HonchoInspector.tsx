import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { api, type MemoryNode } from "@/lib/api";
import { metadataString } from "./constants";

interface HonchoInspectorProps {
  node: MemoryNode;
  onChanged: () => Promise<void> | void;
}

export function HonchoInspector({ node, onChanged }: HonchoInspectorProps) {
  const profile = metadataString(node.metadata?.profile || "default") || "default";
  const peerMeta = node.metadata?.peer && typeof node.metadata.peer === "object" ? node.metadata.peer as Record<string, unknown> : null;
  const peerId = metadataString(node.metadata?.peer_id || peerMeta?.id || peerMeta?.peer_id || node.label);
  const conclusionId = node.kind === "honcho_conclusion" ? node.id.split(":").pop() || "" : "";
  const raw = node.metadata?.raw && typeof node.metadata.raw === "object" ? node.metadata.raw as Record<string, unknown> : null;
  const content = metadataString(node.metadata?.content || node.summary || "");
  const [cardText, setCardText] = useState("");
  const [newConclusion, setNewConclusion] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const card = node.metadata?.peer && typeof node.metadata.peer === "object" ? (node.metadata.peer as Record<string, unknown>).card : undefined;
    setCardText(Array.isArray(card) ? card.join("\n") : "");
    setNewConclusion("");
    setDeleteConfirm("");
    setError(null);
    setMessage(null);
  }, [node.id, node.metadata?.peer]);

  const readOnly = node.kind.includes("message") || node.kind.includes("session") || node.kind === "honcho_workspace";

  const saveCard = async () => {
    if (!peerId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.updateHonchoPeerCard({ profile, peerId, card: cardText.split("\n").map((line) => line.trim()).filter(Boolean) });
      setMessage("Peer card saved.");
      await onChanged();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const addConclusion = async () => {
    if (!peerId || !newConclusion.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.createHonchoConclusion({ profile, peerId, conclusion: newConclusion.trim() });
      setNewConclusion("");
      setMessage("Corrective conclusion added.");
      await onChanged();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteConclusion = async () => {
    if (!conclusionId || deleteConfirm !== "DELETE") return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.deleteHonchoConclusion(profile, conclusionId, true);
      setMessage("Conclusion deleted.");
      await onChanged();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4 rounded border border-midground/20 bg-midground/5 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-foreground/55">Honcho inspector</h3>
        <Badge tone={readOnly ? "outline" : "secondary"} className="text-[0.65rem]">{readOnly ? "read-only" : "editable"}</Badge>
      </div>
      {readOnly && <div className="mb-3 flex gap-2 rounded border border-warning/35 bg-warning/10 p-2 text-xs text-warning"><AlertTriangle className="h-3.5 w-3.5" /> Sessions and raw messages are read-only in V1.</div>}
      <div className="mb-3 space-y-1.5 text-xs text-foreground/55">
        <div>Profile: <span className="font-mono text-foreground/75">{profile}</span></div>
        {peerId && <div>Peer: <span className="font-mono text-foreground/75">{peerId}</span></div>}
      </div>
      {node.kind === "honcho_peer" && !readOnly && (
        <div className="space-y-2">
          <label className="text-[0.65rem] uppercase tracking-widest text-foreground/40">Peer card facts</label>
          <textarea className="min-h-[130px] w-full resize-y rounded border border-current/15 bg-background/60 p-2 text-xs" value={cardText} onChange={(e) => setCardText(e.target.value)} placeholder="One fact per line" />
          <Button size="sm" onClick={saveCard} disabled={busy || !peerId}>{busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}Save peer card</Button>
        </div>
      )}
      {node.kind === "honcho_conclusion" && (
        <div className="space-y-3">
          <pre className="whitespace-pre-wrap rounded border border-current/10 bg-current/5 p-2 text-xs text-foreground/75">{content}</pre>
          {raw && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-current/10 bg-background/60 p-2 font-mono text-[0.68rem] text-foreground/50">{JSON.stringify(raw, null, 2)}</pre>}
          <textarea className="min-h-[90px] w-full resize-y rounded border border-current/15 bg-background/60 p-2 text-xs" value={newConclusion} onChange={(e) => setNewConclusion(e.target.value)} placeholder="Add a corrective conclusion instead of editing raw history" />
          <Button size="sm" onClick={addConclusion} disabled={busy || !peerId || !newConclusion.trim()}><Plus className="mr-1.5 h-3.5 w-3.5" />Add corrective conclusion</Button>
          <div className="rounded border border-destructive/20 bg-destructive/5 p-2">
            <input className="mb-2 w-full rounded border border-current/15 bg-background/60 px-2 py-1.5 text-xs" value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder="Type DELETE to confirm conclusion delete" />
            <Button ghost size="sm" onClick={deleteConclusion} disabled={busy || deleteConfirm !== "DELETE"}><Trash2 className="mr-1.5 h-3.5 w-3.5 text-destructive" />Delete conclusion</Button>
          </div>
        </div>
      )}
      {error && <div className="mt-3 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
      {message && <div className="mt-3 rounded border border-midground/30 bg-midground/10 p-2 text-xs text-midground">{message}</div>}
    </section>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
