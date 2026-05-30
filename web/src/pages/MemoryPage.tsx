/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { BrainCircuit, Database, FileText, GitBranch, RefreshCw, Search, Users } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api, type MemoryEdge, type MemoryGraphResponse, type MemoryNode, type MemoryProfileInfo, type MemorySearchResult } from "@/lib/api";

const SOURCE_COLORS: Record<string, string> = {
  hermes: "#84cc16",
  honcho: "#d946ef",
  wiki: "#38bdf8",
  derived: "#f59e0b",
};

const SOURCE_LABELS: Record<string, string> = {
  hermes: "Hermes",
  honcho: "Honcho",
  wiki: "LLM Wiki",
  derived: "Derived",
};

type GraphNode = MemoryNode & { x?: number; y?: number; vx?: number; vy?: number; val?: number; color?: string };
type GraphLink = { source: string | GraphNode; target: string | GraphNode; kind: string; id: string; color?: string };

type SourceFilter = "all" | "hermes" | "honcho" | "wiki";
type GraphMode = "global" | "local";

function nodeSize(node: MemoryNode): number {
  if (node.kind === "profile" || node.kind === "wiki_root" || node.kind === "honcho_workspace") return 8;
  if (node.kind === "wiki_page" || node.kind === "honcho_peer") return 6;
  if (node.kind.includes("entry") || node.kind.includes("conclusion")) return 4.5;
  return 3.5;
}

function metadataString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function MemoryPage() {
  const [graph, setGraph] = useState<MemoryGraphResponse | null>(null);
  const [profiles, setProfiles] = useState<MemoryProfileInfo[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [mode, setMode] = useState<GraphMode>("global");
  const [includeMessages, setIncludeMessages] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemorySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const graphHostRef = useRef<HTMLElement | null>(null);
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 });
  const { setEnd } = usePageHeader();

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getMemoryProfiles(),
      api.getMemoryGraph({ profiles: selectedProfile, includeMessages, includeRawSources: true, includeDerivedEdges: true }),
    ])
      .then(([profileRes, graphRes]) => {
        setProfiles(profileRes.profiles);
        setGraph(graphRes);
        if (selectedNodeId && !graphRes.nodes.some((n) => n.id === selectedNodeId)) {
          setSelectedNodeId(null);
        }
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [includeMessages, selectedNodeId, selectedProfile]);

  useEffect(() => {
    const host = graphHostRef.current;
    if (!host) return;

    const measure = () => {
      setGraphSize({ width: host.clientWidth, height: host.clientHeight });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setEnd(
      <Button ghost size="sm" onClick={refresh} disabled={loading}>
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        <span className="ml-1.5 hidden sm:inline">Refresh</span>
      </Button>,
    );
    return () => setEnd(null);
  }, [loading, refresh, setEnd]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .searchMemory(trimmed, { profiles: selectedProfile, limit: 20 })
        .then((res) => setResults(res.results))
        .catch(() => setResults([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, selectedProfile]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph, selectedNodeId],
  );

  const visibleGraph = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    const selectedNeighborhood = new Set<string>();
    if (mode === "local" && selectedNodeId) {
      selectedNeighborhood.add(selectedNodeId);
      for (const edge of graph.edges) {
        if (edge.from === selectedNodeId) selectedNeighborhood.add(edge.to);
        if (edge.to === selectedNodeId) selectedNeighborhood.add(edge.from);
      }
      for (const edge of graph.edges) {
        if (selectedNeighborhood.has(edge.from) || selectedNeighborhood.has(edge.to)) {
          selectedNeighborhood.add(edge.from);
          selectedNeighborhood.add(edge.to);
        }
      }
    }

    const nodes: GraphNode[] = graph.nodes
      .filter((node) => sourceFilter === "all" || node.source === sourceFilter)
      .filter((node) => mode === "global" || !selectedNodeId || selectedNeighborhood.has(node.id))
      .map((node) => ({ ...node, val: nodeSize(node), color: SOURCE_COLORS[node.source] ?? "#94a3b8" }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links = graph.edges
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .map((edge) => ({ id: edge.id, source: edge.from, target: edge.to, kind: edge.kind, color: edge.source === "derived" ? "rgba(245, 158, 11, 0.28)" : "rgba(148, 163, 184, 0.28)" }));
    return { nodes, links };
  }, [graph, mode, selectedNodeId, sourceFilter]);

  const focusNode = useCallback((id: string) => {
    setSelectedNodeId(id);
    const fg = graphRef.current;
    const node = visibleGraph.nodes.find((n) => n.id === id);
    if (fg && node && typeof node.x === "number" && typeof node.y === "number") {
      fg.centerAt(node.x, node.y, 600);
      fg.zoom(3, 600);
    }
  }, [visibleGraph.nodes]);

  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-320);
    fg.d3Force("link")?.distance(92);
    fg.d3ReheatSimulation();
  }, [visibleGraph.nodes.length, visibleGraph.links.length]);

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col gap-4">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-foreground/40">Memory Workbench</p>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <BrainCircuit className="h-5 w-5 text-midground" /> Unified memory graph
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-foreground/50">
            Read-only Obsidian-style graph over Hermes hot memory, Honcho metadata, and the LLM Wiki. Editing/promote flows come next.
          </p>
        </div>
        {graph && (
          <div className="grid grid-cols-3 gap-2 text-right text-xs sm:flex sm:items-center">
            <Metric label="Profiles" value={graph.summary.profiles} />
            <Metric label="Nodes" value={graph.summary.nodes} />
            <Metric label="Edges" value={graph.summary.edges} />
            <Metric label="Hot memory" value={graph.summary.hermes_entries} />
            <Metric label="Wiki pages" value={graph.summary.wiki_pages} />
            <Metric label="Honcho" value={graph.summary.honcho_nodes} />
          </div>
        )}
      </header>

      {error && <div className="rounded border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
      {graph?.warnings?.length ? (
        <div className="rounded border border-warning/30 bg-warning/10 px-4 py-3 text-xs text-warning">
          {graph.warnings.slice(0, 3).map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      ) : null}

      <div className="grid min-h-[680px] gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="rounded border border-current/10 bg-background/45 p-3">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <GitBranch className="h-4 w-4" /> Sources
          </div>
          <label className="mb-1 block text-xs uppercase tracking-widest text-foreground/40">Profile</label>
          <select
            value={selectedProfile}
            onChange={(e) => setSelectedProfile(e.target.value)}
            className="mb-4 w-full rounded border border-current/15 bg-background px-2 py-2 text-sm"
          >
            <option value="all">All profiles</option>
            {profiles.map((profile) => (
              <option value={profile.name} key={profile.name}>{profile.name}</option>
            ))}
          </select>

          <label className="mb-1 block text-xs uppercase tracking-widest text-foreground/40">Source</label>
          <div className="mb-4 grid gap-1">
            {(["all", "hermes", "honcho", "wiki"] as SourceFilter[]).map((source) => (
              <button
                key={source}
                onClick={() => setSourceFilter(source)}
                className={`flex items-center justify-between rounded px-2 py-2 text-left text-sm transition-colors ${sourceFilter === source ? "bg-midground/15 text-midground" : "hover:bg-current/5"}`}
              >
                <span>{source === "all" ? "All sources" : SOURCE_LABELS[source]}</span>
                {source !== "all" && <span className="h-2.5 w-2.5 rounded-full" style={{ background: SOURCE_COLORS[source] }} />}
              </button>
            ))}
          </div>

          <label className="mb-1 block text-xs uppercase tracking-widest text-foreground/40">Graph mode</label>
          <div className="mb-4 grid grid-cols-2 gap-1 rounded bg-current/5 p-1">
            {(["global", "local"] as GraphMode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`rounded px-2 py-1.5 text-xs capitalize ${mode === m ? "bg-background text-midground shadow" : "text-foreground/55"}`}>
                {m}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground/70">
            <input type="checkbox" checked={includeMessages} onChange={(e) => setIncludeMessages(e.target.checked)} />
            Include Honcho messages
          </label>
          <p className="mt-1 text-xs text-foreground/35">Messages are graph-schema ready but intentionally hidden by default.</p>

          <div className="mt-6 space-y-2 text-xs text-foreground/45">
            <LegendItem color={SOURCE_COLORS.hermes} label="Hermes hot memory" />
            <LegendItem color={SOURCE_COLORS.honcho} label="Honcho" />
            <LegendItem color={SOURCE_COLORS.wiki} label="LLM Wiki" />
            <LegendItem color={SOURCE_COLORS.derived} label="Derived mentions" />
          </div>
        </aside>

        <main ref={graphHostRef} className="relative overflow-hidden rounded border border-current/10 bg-background/35">
          <div className="absolute left-3 right-3 top-3 z-10 flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-foreground/35" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memory across Hermes, Honcho, Wiki…" className="pl-8" />
            </div>
            {loading && <div className="flex items-center gap-2 rounded border border-current/10 bg-background/80 px-3 text-xs"><Spinner /> Loading</div>}
          </div>

          {results.length > 0 && (
            <div className="absolute left-3 top-14 z-20 max-h-72 w-[min(680px,calc(100%-1.5rem))] overflow-auto rounded border border-current/10 bg-background/95 p-2 shadow-xl backdrop-blur">
              {results.map((result) => (
                <button key={result.id} className="block w-full rounded px-3 py-2 text-left hover:bg-current/5" onClick={() => { focusNode(result.id); setQuery(""); setResults([]); }}>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="h-2 w-2 rounded-full" style={{ background: SOURCE_COLORS[result.source] ?? "#94a3b8" }} />
                    {result.title}
                    <Badge tone="outline" className="text-[0.65rem]">{result.kind}</Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-foreground/45">{result.snippet}</p>
                </button>
              ))}
            </div>
          )}

          {visibleGraph.nodes.length === 0 && !loading ? (
            <div className="flex h-full min-h-[680px] flex-col items-center justify-center text-foreground/40">
              <Database className="mb-3 h-10 w-10 opacity-40" />
              <p>No memory nodes found.</p>
            </div>
          ) : (
            <ForceGraph2D<GraphNode, GraphLink>
              ref={graphRef}
              graphData={visibleGraph}
              width={Math.max(graphSize.width, 1)}
              height={Math.max(graphSize.height, 1)}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={6}
              nodeVal={(node) => node.val ?? 4}
              nodeLabel={(node) => `${node.label}\n${node.kind}`}
              nodeColor={(node) => node.color ?? SOURCE_COLORS[node.source] ?? "#94a3b8"}
              linkColor={(link) => link.color ?? "rgba(148,163,184,0.22)"}
              linkWidth={(link) => (link.kind === "wikilink" || link.kind === "contains" ? 1.1 : 0.6)}
              linkDirectionalParticles={(link) => (link.kind === "wikilink" ? 1 : 0)}
              linkDirectionalParticleWidth={1.4}
              onNodeClick={(node) => setSelectedNodeId(node.id)}
              onNodeHover={(node) => {
                setHoveredNodeId(node?.id ?? null);
                document.body.style.cursor = node ? "pointer" : "default";
              }}
              nodeCanvasObjectMode={() => "after"}
              nodeCanvasObject={(node, ctx, globalScale) => {
                const isSelected = node.id === selectedNodeId;
                const isHovered = node.id === hoveredNodeId;
                const isAnchor = node.kind === "profile" || node.kind === "wiki_root" || node.kind === "honcho_workspace";
                const shouldLabel = isSelected || isHovered || isAnchor || globalScale > 2.1;
                const x = node.x ?? 0;
                const y = node.y ?? 0;

                if (isSelected || isHovered) {
                  ctx.beginPath();
                  ctx.arc(x, y, (node.val ?? 4) * 4.1, 0, Math.PI * 2);
                  ctx.strokeStyle = isSelected ? "rgba(255, 255, 255, 0.95)" : "rgba(226, 232, 240, 0.65)";
                  ctx.lineWidth = Math.max(1.2, 2.5 / globalScale);
                  ctx.stroke();
                }

                if (!shouldLabel) return;

                const label = node.label.length > 42 ? `${node.label.slice(0, 39)}…` : node.label;
                const fontSize = isSelected || isHovered ? Math.max(11, 15 / globalScale) : Math.max(9, 12 / globalScale);
                ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                const metrics = ctx.measureText(label);
                const padX = 5 / globalScale;
                const padY = 3 / globalScale;
                const boxW = metrics.width + padX * 2;
                const boxH = fontSize + padY * 2;
                const boxX = x - boxW / 2;
                const boxY = y + (node.val ?? 4) * 4.4;
                ctx.fillStyle = isSelected || isHovered ? "rgba(2, 6, 23, 0.94)" : "rgba(2, 6, 23, 0.78)";
                ctx.strokeStyle = node.color ?? SOURCE_COLORS[node.source] ?? "rgba(148, 163, 184, 0.65)";
                ctx.lineWidth = Math.max(0.8, 1 / globalScale);
                ctx.beginPath();
                ctx.roundRect(boxX, boxY, boxW, boxH, 4 / globalScale);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = "rgba(248, 250, 252, 0.96)";
                ctx.fillText(label, x, boxY + boxH / 2);
              }}
            />
          )}

          {visibleGraph.nodes.length > 0 && (
            <div className="absolute right-3 top-16 z-10 max-h-64 w-[min(26rem,calc(100%-1.5rem))] overflow-auto rounded border border-current/10 bg-background/90 p-2 shadow-xl backdrop-blur">
              <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[0.65rem] uppercase tracking-widest text-foreground/40">
                <span>Nodes</span>
                <span>{visibleGraph.nodes.length}</span>
              </div>
              <div className="grid gap-1 sm:grid-cols-2">
                {visibleGraph.nodes.map((node) => (
                  <button
                    key={node.id}
                    onClick={() => focusNode(node.id)}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                    className={`flex min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-current/5 ${selectedNodeId === node.id ? "bg-midground/15 text-midground" : "text-foreground/75"}`}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: node.color ?? SOURCE_COLORS[node.source] ?? "#94a3b8" }} />
                    <span className="truncate">{node.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>

        <div className="xl:col-start-2">
          <MemoryInspector node={selectedNode} edges={graph?.edges ?? []} nodes={graph?.nodes ?? []} onFocus={focusNode} />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-current/10 bg-current/5 px-3 py-2">
      <div className="text-base font-bold leading-none">{value}</div>
      <div className="mt-1 whitespace-nowrap text-[0.65rem] uppercase tracking-widest text-foreground/35">{label}</div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function MemoryInspector({ node, edges, nodes, onFocus }: { node: MemoryNode | null; edges: MemoryEdge[]; nodes: MemoryNode[]; onFocus: (id: string) => void }) {
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

  const content = metadataString(node.metadata?.content || node.summary || "");
  const path = metadataString(node.metadata?.path || node.metadata?.relative_path || "");
  const profile = metadataString(node.metadata?.profile || "");

  return (
    <aside className="overflow-hidden rounded border border-current/10 bg-background/45">
      <div className="border-b border-current/10 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: SOURCE_COLORS[node.source] ?? "#94a3b8" }} />
          <Badge tone="outline" className="text-[0.65rem]">{SOURCE_LABELS[node.source] ?? node.source}</Badge>
          <Badge tone={node.editable ? "secondary" : "outline"} className="text-[0.65rem]">{node.editable ? "editable later" : "read-only"}</Badge>
        </div>
        <h2 className="break-words text-lg font-semibold leading-tight">{node.label}</h2>
        <p className="mt-1 break-all font-mono text-[0.68rem] text-foreground/35">{node.id}</p>
      </div>

      <div className="max-h-[620px] overflow-auto p-4">
        <InfoRow icon={<Database className="h-3.5 w-3.5" />} label="Kind" value={node.kind} />
        {profile && <InfoRow icon={<Users className="h-3.5 w-3.5" />} label="Profile" value={profile} />}
        {path && <InfoRow icon={<FileText className="h-3.5 w-3.5" />} label="Path" value={path} mono />}

        {content && (
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

function InfoRow({ icon, label, value, mono = false }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="mb-2 grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-xs">
      <div className="flex items-center gap-1.5 text-foreground/40">{icon}{label}</div>
      <div className={`break-words text-foreground/70 ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
