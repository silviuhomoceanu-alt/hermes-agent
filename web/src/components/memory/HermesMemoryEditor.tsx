import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, FileText, Loader2, Save, Trash2, Users } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { api, type HermesMemoryEntry, type HermesMemoryStore, type HermesMemoryTarget, type MemoryNode, type MemoryProfileInfo } from "@/lib/api";
import { metadataString } from "./constants";

interface HermesMemoryEditorProps {
  node: MemoryNode;
  profiles: MemoryProfileInfo[];
  onChanged: () => Promise<void> | void;
}

type LoadState = {
  store: HermesMemoryStore;
  entry: HermesMemoryEntry;
};

export function HermesMemoryEditor({ node, profiles, onChanged }: HermesMemoryEditorProps) {
  const profile = metadataString(node.metadata?.profile || "default") || "default";
  const target = normalizeTarget(node.metadata?.target);
  const nodeIndex = typeof node.metadata?.index === "number" ? node.metadata.index : Number(node.metadata?.index ?? -1);
  const fallbackContent = metadataString(node.metadata?.content || node.summary || "");
  const profileInfo = profiles.find((item) => item.name === profile);
  const isDefaultProfile = profileInfo?.is_default ?? profile === "default";

  const [loadState, setLoadState] = useState<LoadState | null>(null);
  const [text, setText] = useState(fallbackContent);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!target) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    api
      .getHermesMemory(profile)
      .then((res) => {
        const store = res.stores.find((item) => item.target === target);
        const entry = store?.entries.find((item) => item.index === nodeIndex || item.id === String(nodeIndex));
        if (!store || !entry) {
          setLoadState(null);
          setError("This memory entry is no longer present. Refresh the graph and select it again.");
          return;
        }
        setLoadState({ store, entry });
        setText(entry.content);
        setDeleteConfirm("");
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [nodeIndex, profile, target]);

  useEffect(() => {
    setText(fallbackContent);
    setLoadState(null);
    setDeleteConfirm("");
    if (target) load();
  }, [fallbackContent, load, target]);

  const original = loadState?.entry.content ?? fallbackContent;
  const store = loadState?.store ?? null;
  const dirty = text !== original;
  const trimmedEmpty = text.trim().length === 0;
  const nextUsedChars = store ? store.usedChars - original.length + text.length : text.length;
  const usagePct = store ? Math.min(100, Math.round((nextUsedChars / Math.max(store.charLimit, 1)) * 100)) : 0;
  const overLimit = store ? nextUsedChars > store.charLimit : false;

  const diff = useMemo(() => buildDiff(original, text), [original, text]);

  const save = async () => {
    if (!target || !loadState) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.updateHermesMemory(profile, target, loadState.entry.id, {
        content: text,
        expectedOldContent: original,
      });
      setMessage(res.message || "Memory entry saved.");
      await onChanged();
      load();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!target || !loadState || deleteConfirm !== "DELETE") return;
    setDeleting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.deleteHermesMemory(profile, target, loadState.entry.id, {
        expectedOldContent: original,
      });
      setMessage(res.message || "Memory entry deleted.");
      setLoadState(null);
      setText("");
      setDeleteConfirm("");
      await onChanged();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setDeleting(false);
    }
  };

  if (!target) return null;

  return (
    <section className="mt-4 rounded border border-midground/20 bg-midground/5 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-foreground/55">Hermes hot-memory editor</h3>
        <Badge tone="secondary" className="text-[0.65rem]">{target.toUpperCase()}</Badge>
      </div>

      {!isDefaultProfile && (
        <div className="mb-3 flex gap-2 rounded border border-warning/35 bg-warning/10 p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Editing non-active profile: <strong>{profile}</strong>. This writes that profile’s hot memory, not the default profile.</span>
        </div>
      )}

      <div className="mb-3 space-y-1.5 text-xs">
        <InfoLine icon={<Users className="h-3.5 w-3.5" />} label="Profile" value={profile} />
        <InfoLine icon={<FileText className="h-3.5 w-3.5" />} label="Path" value={store?.path || metadataString(node.metadata?.path || "")} mono />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded border border-current/10 bg-current/5 p-3 text-xs text-foreground/50">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading current memory entry…
        </div>
      ) : (
        <>
          {store && (
            <div className="mb-3">
              <div className="mb-1 flex justify-between text-[0.68rem] text-foreground/45">
                <span>Usage</span>
                <span className={overLimit ? "text-destructive" : ""}>{nextUsedChars} / {store.charLimit} chars</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-current/10">
                <div className={`h-full ${overLimit ? "bg-destructive" : "bg-midground"}`} style={{ width: `${usagePct}%` }} />
              </div>
            </div>
          )}

          <textarea
            className="min-h-[180px] w-full resize-y rounded border border-current/15 bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80 shadow-sm placeholder:text-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[0.68rem] text-foreground/40">
            <span>Entry #{Number.isFinite(nodeIndex) ? nodeIndex : "?"}</span>
            <span className={dirty ? "text-midground" : ""}>{dirty ? `${text.length - original.length >= 0 ? "+" : ""}${text.length - original.length} chars changed` : "No changes"}</span>
          </div>

          {dirty && (
            <div className="mt-3 rounded border border-current/10 bg-current/5 p-2">
              <div className="mb-2 text-[0.65rem] uppercase tracking-widest text-foreground/40">Diff preview</div>
              <div className="grid gap-2 text-[0.68rem] lg:grid-cols-2">
                <DiffPane title="Before" tone="destructive" lines={diff.removed} empty="No removed lines" />
                <DiffPane title="After" tone="midground" lines={diff.added} empty="No added lines" />
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={!dirty || trimmedEmpty || overLimit || saving || deleting || !loadState}>
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
              Save
            </Button>
          </div>

          <div className="mt-4 rounded border border-destructive/20 bg-destructive/5 p-2">
            <div className="mb-2 text-[0.65rem] uppercase tracking-widest text-destructive/80">Delete entry</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="min-w-0 flex-1 rounded border border-current/15 bg-background/60 px-2 py-1.5 text-xs text-foreground/75 placeholder:text-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
                placeholder="Type DELETE to confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
              />
              <Button ghost size="sm" onClick={remove} disabled={deleteConfirm !== "DELETE" || deleting || saving || !loadState}>
                {deleting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5 text-destructive" />}
                Delete
              </Button>
            </div>
          </div>
        </>
      )}

      {error && <div className="mt-3 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
      {message && <div className="mt-3 rounded border border-midground/30 bg-midground/10 p-2 text-xs text-midground">{message}</div>}
    </section>
  );
}

function normalizeTarget(value: unknown): HermesMemoryTarget | null {
  return value === "user" || value === "memory" ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function InfoLine({ icon, label, value, mono = false }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
      <div className="flex items-center gap-1.5 text-foreground/40">{icon}{label}</div>
      <div className={`break-words text-foreground/70 ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function DiffPane({ title, tone, lines, empty }: { title: string; tone: "destructive" | "midground"; lines: string[]; empty: string }) {
  const color = tone === "destructive" ? "text-destructive" : "text-midground";
  return (
    <div className="min-w-0 rounded border border-current/10 bg-background/55 p-2">
      <div className={`mb-1 text-[0.62rem] uppercase tracking-widest ${color}`}>{title}</div>
      {lines.length === 0 ? (
        <div className="text-foreground/35">{empty}</div>
      ) : (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono leading-relaxed text-foreground/70">
          {lines.slice(0, 80).join("\n")}
          {lines.length > 80 ? "\n…" : ""}
        </pre>
      )}
    </div>
  );
}

function buildDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const removed: string[] = [];
  const added: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) removed.push(`- ${oldLine}`);
    if (newLine !== undefined) added.push(`+ ${newLine}`);
  }
  return { removed, added };
}
