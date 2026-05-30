import { useMemo, type ReactNode } from "react";
import { BrainCircuit, Database, FileText, Users } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import type { MemoryEdge, MemoryGraphView, MemoryNode, MemoryProfileInfo } from "@/lib/api";
import { metadataString, SOURCE_COLORS, SOURCE_LABELS } from "./constants";
import { HermesMemoryEditor } from "./HermesMemoryEditor";
import { WikiPageEditor } from "./WikiPageEditor";
import { HonchoInspector } from "./HonchoInspector";

interface MemoryInspectorProps {
  node: MemoryNode | null;
  edges: MemoryEdge[];
  nodes: MemoryNode[];
  profiles: MemoryProfileInfo[];
  graphView: MemoryGraphView;
  onFocus: (id: string) => void;
  onMemoryChanged: () => Promise<void> | void;
}

export function MemoryInspector({ node, edges, nodes, profiles, graphView, onFocus, onMemoryChanged }: MemoryInspectorProps) {
  const related = useMemo(() => {
    if (!node) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges
      .filter((edge) => edge.from === node.id || edge.to === node.id)
      .slice(0, 18)
      .map((edge) => ({ edge, other: byId.get(edge.from === node.id ? edge.to : edge.from) }))
      .filter((item): item is { edge: MemoryEdge; other: MemoryNode } => Boolean(item.other));
  }, [edges, node, nodes]);

  if (!node) {
    return (
      <aside className="rounded border border-current/10 bg-background/45 p-4 text-sm text-foreground/45">
        <BrainCircuit className="mb-3 h-8 w-8 opacity-40" />
        <p className="font-medium text-foreground/70">Select a node</p>
        <p className="mt-1">Click any graph node to inspect memory content, metadata, backlinks, and related nodes.</p>
      </aside>
    );
  }

  const exactContent = metadataString(node.metadata?.content || "");
  const fallbackContent = metadataString(node.summary || "");
  const content = exactContent || fallbackContent;
  const path = metadataString(node.metadata?.path || node.metadata?.relative_path || "");
  const profile = metadataString(node.metadata?.profile || "");
  const provenance = provenanceRows(node.metadata?.provenance);
  const isStoredContentView = graphView === "stored_content";
  const isHermesEntry = node.kind === "hermes_user_entry" || node.kind === "hermes_memory_entry";
  const isWikiPage = node.kind === "wiki_page" || node.kind === "wiki_raw_source";
  const isHonchoNode = node.source === "honcho";

  return (
    <aside className="overflow-hidden rounded border border-current/10 bg-background/45">
      <div className="border-b border-current/10 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: SOURCE_COLORS[node.source] ?? "#94a3b8" }} />
          <Badge tone="outline" className="text-[0.65rem]">{SOURCE_LABELS[node.source] ?? node.source}</Badge>
          <Badge tone={node.editable ? "secondary" : "outline"} className="text-[0.65rem]">{node.editable ? "editable" : "read-only"}</Badge>
        </div>
        <h2 className="break-words text-lg font-semibold leading-tight">{node.label}</h2>
        <p className="mt-1 break-all font-mono text-[0.68rem] text-foreground/35">{node.id}</p>
      </div>

      <div className="max-h-[620px] overflow-auto p-4">
        <InfoRow icon={<Database className="h-3.5 w-3.5" />} label="Kind" value={node.kind} />
        {profile && <InfoRow icon={<Users className="h-3.5 w-3.5" />} label="Profile" value={profile} />}
        {path && <InfoRow icon={<FileText className="h-3.5 w-3.5" />} label="Path" value={path} mono />}

        {isStoredContentView && (
          <section className="mt-4 rounded border border-midground/25 bg-midground/5 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs uppercase tracking-widest text-foreground/55">Exact stored content</h3>
              <Badge tone="secondary" className="text-[0.65rem]">raw record</Badge>
            </div>
            {exactContent ? (
              <pre className="max-h-80 whitespace-pre-wrap rounded border border-current/10 bg-background/65 p-3 font-mono text-xs leading-relaxed text-foreground/80">{exactContent}</pre>
            ) : (
              <p className="rounded border border-warning/25 bg-warning/10 p-2 text-xs text-warning">
                This stored-content node has no metadata.content payload; the title and summary above are the available stored fields.
              </p>
            )}
            <div className="mt-2 text-[0.68rem] text-foreground/40">
              Shown verbatim from the storage backend. No summaries, entity extraction, or analysis are applied here.
            </div>
          </section>
        )}

        {isStoredContentView && provenance.length > 0 && (
          <section className="mt-3 rounded border border-current/10 bg-current/5 p-3">
            <h3 className="mb-2 text-xs uppercase tracking-widest text-foreground/40">Storage provenance</h3>
            <div className="space-y-1.5">
              {provenance.map(([label, value]) => (
                <InfoRow key={label} icon={<Database className="h-3.5 w-3.5" />} label={label} value={value} mono={label === "Path" || label === "ID" || label === "Peer ID"} />
              ))}
            </div>
          </section>
        )}

        {isHermesEntry && <HermesMemoryEditor node={node} profiles={profiles} onChanged={onMemoryChanged} />}
        {isWikiPage && <WikiPageEditor node={node} onChanged={onMemoryChanged} />}
        {isHonchoNode && <HonchoInspector node={node} onChanged={onMemoryChanged} />}

        {!isStoredContentView && content && (
          <section className="mt-4">
            <h3 className="mb-2 text-xs uppercase tracking-widest text-foreground/40">Content</h3>
            <pre className="max-h-64 whitespace-pre-wrap rounded border border-current/10 bg-current/5 p-3 text-xs leading-relaxed text-foreground/75">{content}</pre>
          </section>
        )}

        <section className="mt-4">
          <h3 className="mb-2 text-xs uppercase tracking-widest text-foreground/40">Related</h3>
          {related.length === 0 ? (
            <p className="text-sm text-foreground/40">No visible graph edges.</p>
          ) : (
            <div className="space-y-1.5">
              {related.map(({ edge, other }) => (
                <button key={edge.id} onClick={() => onFocus(other.id)} className="block w-full rounded border border-current/10 px-3 py-2 text-left hover:bg-current/5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{other.label}</span>
                    <span className="font-mono text-[0.62rem] text-foreground/35">{edge.kind}</span>
                  </div>
                  <div className="mt-0.5 text-[0.68rem] text-foreground/35">{other.kind}</div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function InfoRow({ icon, label, value, mono = false }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="mb-2 grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-xs">
      <div className="flex items-center gap-1.5 text-foreground/40">{icon}{label}</div>
      <div className={`break-words text-foreground/70 ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function provenanceRows(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const provenance = value as Record<string, unknown>;
  const keys: Array<[string, string]> = [
    ["Source", "source"],
    ["Store", "store"],
    ["Profile", "profile"],
    ["Target", "target"],
    ["Kind", "kind"],
    ["Index", "index"],
    ["Path", "path"],
    ["Relative path", "relative_path"],
    ["ID", "id"],
    ["Peer ID", "peer_id"],
  ];
  return keys
    .map(([label, key]) => [label, metadataString(provenance[key])] as [string, string])
    .filter(([, rowValue]) => rowValue.length > 0);
}
