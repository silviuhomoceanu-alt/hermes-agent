import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { api, type MemoryNode, type WikiPageResponse } from "@/lib/api";
import { metadataString } from "./constants";
import { MemoryDiffDialog } from "./MemoryDiffDialog";

interface WikiPageEditorProps {
  node: MemoryNode;
  onChanged: () => Promise<void> | void;
}

export function WikiPageEditor({ node, onChanged }: WikiPageEditorProps) {
  const profile = metadataString(node.metadata?.profile || "default") || "default";
  const path = metadataString(node.metadata?.relative_path || node.metadata?.path || "");
  const readOnly = node.kind === "wiki_raw_source" || path.startsWith("raw/") || !node.editable;
  const [page, setPage] = useState<WikiPageResponse | null>(null);
  const [frontmatterText, setFrontmatterText] = useState("{}");
  const [body, setBody] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState("");
  const [renameTo, setRenameTo] = useState(path);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    api.getWikiPage(profile, path)
      .then((res) => {
        setPage(res);
        setFrontmatterText(JSON.stringify(res.frontmatter, null, 2));
        setBody(res.body);
        setRaw(res.raw);
        setRenameTo(res.path);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [path, profile]);

  const nextRaw = useMemo(() => {
    if (rawMode) return raw;
    try {
      const parsed = JSON.parse(frontmatterText || "{}");
      return `---\n${toYamlish(parsed)}---\n${body}`;
    } catch {
      return page?.raw ?? "";
    }
  }, [body, frontmatterText, page?.raw, raw, rawMode]);
  const dirty = page ? nextRaw !== page.raw : false;

  const save = async () => {
    if (!page || readOnly) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = rawMode
        ? await api.saveWikiPage({ profile, path: page.path, raw })
        : await api.saveWikiPage({ profile, path: page.path, frontmatter: JSON.parse(frontmatterText || "{}"), body });
      setPage(res);
      setRaw(res.raw);
      setBody(res.body);
      setFrontmatterText(JSON.stringify(res.frontmatter, null, 2));
      setMessage("Wiki page saved.");
      await onChanged();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const rename = async () => {
    if (!page || readOnly || !renameTo.trim() || renameTo === page.path) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.renameWikiPage({ profile, oldPath: page.path, newPath: renameTo.trim() });
      setPage(res);
      setRenameTo(res.path);
      setMessage("Wiki page renamed.");
      await onChanged();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-4 rounded border border-midground/20 bg-midground/5 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-foreground/55">LLM Wiki editor</h3>
        <Badge tone={readOnly ? "outline" : "secondary"} className="text-[0.65rem]">{readOnly ? "read-only" : "editable"}</Badge>
      </div>
      {readOnly && <div className="mb-3 flex gap-2 rounded border border-warning/35 bg-warning/10 p-2 text-xs text-warning"><AlertTriangle className="h-3.5 w-3.5" /> raw/** source pages cannot be edited from the dashboard.</div>}
      {loading ? <div className="flex items-center gap-2 text-xs text-foreground/45"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading wiki page…</div> : page && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input className="rounded border border-current/15 bg-background/60 px-2 py-1.5 font-mono text-xs" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} disabled={readOnly || saving} />
            <Button ghost size="sm" onClick={rename} disabled={readOnly || saving || renameTo === page.path}>Rename</Button>
          </div>
          <div className="flex gap-2 text-xs"><button className={rawMode ? "text-foreground/45" : "text-midground"} onClick={() => setRawMode(false)}>Structured</button><button className={rawMode ? "text-midground" : "text-foreground/45"} onClick={() => setRawMode(true)}>Raw Markdown</button></div>
          {rawMode ? <textarea className="min-h-[260px] w-full resize-y rounded border border-current/15 bg-background/60 p-2 font-mono text-xs" value={raw} onChange={(e) => setRaw(e.target.value)} disabled={readOnly} /> : (
            <div className="space-y-2">
              <textarea className="min-h-[110px] w-full resize-y rounded border border-current/15 bg-background/60 p-2 font-mono text-xs" value={frontmatterText} onChange={(e) => setFrontmatterText(e.target.value)} disabled={readOnly} />
              <textarea className="min-h-[220px] w-full resize-y rounded border border-current/15 bg-background/60 p-2 font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} disabled={readOnly} />
            </div>
          )}
          {dirty && <MemoryDiffDialog before={page.raw} after={nextRaw} />}
          <Button size="sm" onClick={save} disabled={readOnly || !dirty || saving}>{saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}Save</Button>
        </div>
      )}
      {error && <div className="mt-3 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
      {message && <div className="mt-3 rounded border border-midground/30 bg-midground/10 p-2 text-xs text-midground">{message}</div>}
    </section>
  );
}

function toYamlish(value: Record<string, unknown>): string {
  return Object.entries(value).map(([key, val]) => `${key}: ${Array.isArray(val) ? `[${val.join(", ")}]` : JSON.stringify(val).replace(/^"|"$/g, "")}`).join("\n") + "\n";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
