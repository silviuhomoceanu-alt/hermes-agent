/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrainCircuit, RefreshCw } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api, type MemoryGraphResponse, type MemoryProfileInfo, type MemorySearchResult } from "@/lib/api";
import { MemoryGraph } from "@/components/memory/MemoryGraph";
import { MemoryInspector } from "@/components/memory/MemoryInspector";
import { MemorySearch } from "@/components/memory/MemorySearch";
import { MemorySourceSidebar } from "@/components/memory/MemorySourceSidebar";
import { nodeSize, SOURCE_COLORS } from "@/components/memory/constants";
import type { GraphLink, GraphMode, GraphNode, SourceFilter } from "@/components/memory/types";

export default function MemoryPage() {
  const [graph, setGraph] = useState<MemoryGraphResponse | null>(null);
  const [profiles, setProfiles] = useState<MemoryProfileInfo[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [mode, setMode] = useState<GraphMode>("global");
  const [includeMessages, setIncludeMessages] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedNodeRevision, setFocusedNodeRevision] = useState(0);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemorySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setFocusedNodeRevision((revision) => revision + 1);
  }, []);

  const clearSearchResults = useCallback(() => {
    setQuery("");
    setResults([]);
  }, []);

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
        <MemorySourceSidebar
          profiles={profiles}
          selectedProfile={selectedProfile}
          onSelectedProfileChange={setSelectedProfile}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          mode={mode}
          onModeChange={setMode}
          includeMessages={includeMessages}
          onIncludeMessagesChange={setIncludeMessages}
        />

        <MemoryGraph
          graphData={visibleGraph}
          loading={loading}
          selectedNodeId={selectedNodeId}
          focusedNodeRevision={focusedNodeRevision}
          hoveredNodeId={hoveredNodeId}
          onNodeSelect={setSelectedNodeId}
          onNodeHover={setHoveredNodeId}
        >
          <MemorySearch
            query={query}
            onQueryChange={setQuery}
            results={results}
            loading={loading}
            onFocusResult={focusNode}
            onClearResults={clearSearchResults}
          />
        </MemoryGraph>

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
