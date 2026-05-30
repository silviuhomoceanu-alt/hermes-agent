/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrainCircuit, RefreshCw } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api, type MemoryEdge, type MemoryGraphResponse, type MemoryProfileInfo, type MemorySearchResult } from "@/lib/api";
import { MemoryGraph } from "@/components/memory/MemoryGraph";
import { MemoryInspector } from "@/components/memory/MemoryInspector";
import { MemorySearch } from "@/components/memory/MemorySearch";
import { MemorySourceSidebar } from "@/components/memory/MemorySourceSidebar";
import { nodeSize, SOURCE_COLORS } from "@/components/memory/constants";
import type { GraphDensitySettings, GraphLink, GraphMode, GraphNode, SourceFilter } from "@/components/memory/types";

const DEFAULT_DENSITY_SETTINGS: GraphDensitySettings = {
  maxNodes: 200,
  localDepth: 2,
  includeDerivedEdges: true,
  includeRawSources: true,
  includeMessages: false,
  nodeLabelDensity: "balanced",
  showEdgeLabels: false,
};

export default function MemoryPage() {
  const [graph, setGraph] = useState<MemoryGraphResponse | null>(null);
  const [profiles, setProfiles] = useState<MemoryProfileInfo[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [mode, setMode] = useState<GraphMode>("global");
  const [densitySettings, setDensitySettings] = useState<GraphDensitySettings>(DEFAULT_DENSITY_SETTINGS);
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
    return Promise.all([
      api.getMemoryProfiles(),
      api.getMemoryGraph({
        profiles: selectedProfile,
        includeMessages: densitySettings.includeMessages,
        includeRawSources: densitySettings.includeRawSources,
        includeDerivedEdges: densitySettings.includeDerivedEdges,
      }),
    ])
      .then(([profileRes, graphRes]) => {
        setProfiles(profileRes.profiles);
        setGraph(graphRes);
        setSelectedNodeId((current) => (current && !graphRes.nodes.some((n) => n.id === current) ? null : current));
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [densitySettings.includeDerivedEdges, densitySettings.includeMessages, densitySettings.includeRawSources, selectedProfile]);

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

    const localNodeIds = selectedNodeId && mode === "local"
      ? collectNeighborhood(selectedNodeId, graph.edges, densitySettings.localDepth)
      : null;

    const baseNodes = graph.nodes
      .filter((node) => sourceFilter === "all" || node.source === sourceFilter)
      .filter((node) => !localNodeIds || localNodeIds.has(node.id));

    const baseIds = new Set(baseNodes.map((node) => node.id));
    const degreeByNode = new Map<string, number>();
    for (const edge of graph.edges) {
      if (!baseIds.has(edge.from) || !baseIds.has(edge.to)) continue;
      degreeByNode.set(edge.from, (degreeByNode.get(edge.from) ?? 0) + 1);
      degreeByNode.set(edge.to, (degreeByNode.get(edge.to) ?? 0) + 1);
    }

    const limitedNodes = [...baseNodes]
      .sort((a, b) => nodeRank(b, selectedNodeId, degreeByNode) - nodeRank(a, selectedNodeId, degreeByNode) || a.label.localeCompare(b.label))
      .slice(0, densitySettings.maxNodes)
      .map((node) => ({
        ...node,
        val: nodeSize(node),
        color: SOURCE_COLORS[node.source] ?? "#94a3b8",
        visibleDegree: degreeByNode.get(node.id) ?? 0,
      }));

    const nodeIds = new Set(limitedNodes.map((node) => node.id));
    const links = graph.edges
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .map((edge) => ({ id: edge.id, source: edge.from, target: edge.to, kind: edge.kind, color: edge.source === "derived" ? "rgba(245, 158, 11, 0.28)" : "rgba(148, 163, 184, 0.28)" }));

    return { nodes: limitedNodes, links };
  }, [densitySettings.localDepth, densitySettings.maxNodes, graph, mode, selectedNodeId, sourceFilter]);

  const focusNode = useCallback((id: string) => {
    setSelectedNodeId(id);
    setFocusedNodeRevision((revision) => revision + 1);
  }, []);

  const clearSearchResults = useCallback(() => {
    setQuery("");
    setResults([]);
  }, []);

  const inspectorProps = {
    node: selectedNode,
    edges: graph?.edges ?? [],
    nodes: graph?.nodes ?? [],
    profiles,
    onFocus: focusNode,
    onMemoryChanged: refresh,
  };

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col gap-4">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-foreground/40">Memory Workbench</p>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <BrainCircuit className="h-5 w-5 text-midground" /> Unified memory graph
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-foreground/50">
            Obsidian-style graph over Hermes hot memory, Honcho metadata, and the LLM Wiki. Use density controls to keep large memory graphs navigable.
          </p>
        </div>
        {graph && (
          <div className="grid grid-cols-3 gap-2 text-right text-xs sm:flex sm:items-center">
            <Metric label="Profiles" value={graph.summary.profiles} />
            <Metric label="Nodes" value={graph.summary.nodes} />
            <Metric label="Shown" value={visibleGraph.nodes.length} />
            <Metric label="Edges" value={graph.summary.edges} />
            <Metric label="Shown edges" value={visibleGraph.links.length} />
            <Metric label="Wiki pages" value={graph.summary.wiki_pages} />
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
          densitySettings={densitySettings}
          onDensitySettingsChange={setDensitySettings}
        />

        <MemoryGraph
          graphData={visibleGraph}
          loading={loading}
          selectedNodeId={selectedNodeId}
          focusedNodeRevision={focusedNodeRevision}
          hoveredNodeId={hoveredNodeId}
          nodeLabelDensity={densitySettings.nodeLabelDensity}
          showEdgeLabels={densitySettings.showEdgeLabels}
          totalNodeCount={graph?.summary.nodes ?? 0}
          totalEdgeCount={graph?.summary.edges ?? 0}
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
          <MemoryInspector {...inspectorProps} />
        </div>
      </div>
    </div>
  );
}

function collectNeighborhood(anchorId: string, edges: MemoryEdge[], depth: number): Set<string> {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, new Set());
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, new Set());
    neighbors.get(edge.from)?.add(edge.to);
    neighbors.get(edge.to)?.add(edge.from);
  }

  const seen = new Set<string>([anchorId]);
  let frontier = new Set<string>([anchorId]);
  for (let hop = 0; hop < depth; hop += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const neighbor of neighbors.get(nodeId) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.add(neighbor);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return seen;
}

function nodeRank(node: GraphNode, selectedNodeId: string | null, degreeByNode: Map<string, number>): number {
  let score = degreeByNode.get(node.id) ?? 0;
  if (node.id === selectedNodeId) score += 1_000_000;
  if (node.kind === "profile" || node.kind === "wiki_root" || node.kind === "honcho_workspace") score += 100_000;
  if (node.kind.endsWith("_store") || node.kind === "wiki_folder") score += 20_000;
  if (node.editable) score += 1_000;
  return score;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-current/10 bg-current/5 px-3 py-2">
      <div className="text-base font-bold leading-none">{value}</div>
      <div className="mt-1 whitespace-nowrap text-[0.65rem] uppercase tracking-widest text-foreground/35">{label}</div>
    </div>
  );
}
