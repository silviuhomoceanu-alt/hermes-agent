import { useEffect, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { Database } from "lucide-react";
import { SOURCE_COLORS } from "./constants";
import type { GraphLink, GraphNode, NodeLabelDensity, VisibleMemoryGraph } from "./types";

interface MemoryGraphProps {
  graphData: VisibleMemoryGraph;
  loading: boolean;
  selectedNodeId: string | null;
  focusedNodeRevision: number;
  hoveredNodeId: string | null;
  nodeLabelDensity: NodeLabelDensity;
  showEdgeLabels: boolean;
  totalNodeCount: number;
  totalEdgeCount: number;
  onNodeSelect: (id: string) => void;
  onNodeHover: (id: string | null) => void;
  children?: React.ReactNode;
}

export function MemoryGraph({ graphData, loading, selectedNodeId, focusedNodeRevision, hoveredNodeId, nodeLabelDensity, showEdgeLabels, totalNodeCount, totalEdgeCount, onNodeSelect, onNodeHover, children }: MemoryGraphProps) {
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const graphHostRef = useRef<HTMLElement | null>(null);
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 });

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
    const fg = graphRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-320);
    fg.d3Force("link")?.distance(92);
    fg.d3ReheatSimulation();
  }, [graphData.nodes.length, graphData.links.length]);

  useEffect(() => {
    if (!selectedNodeId) return;
    const fg = graphRef.current;
    const node = graphData.nodes.find((n) => n.id === selectedNodeId);
    if (fg && node && typeof node.x === "number" && typeof node.y === "number") {
      fg.centerAt(node.x, node.y, 600);
      fg.zoom(3, 600);
    }
  }, [focusedNodeRevision, graphData.nodes, selectedNodeId]);

  const focusNode = (id: string) => {
    onNodeSelect(id);
    const fg = graphRef.current;
    const node = graphData.nodes.find((n) => n.id === id);
    if (fg && node && typeof node.x === "number" && typeof node.y === "number") {
      fg.centerAt(node.x, node.y, 600);
      fg.zoom(3, 600);
    }
  };

  return (
    <main ref={graphHostRef} className="relative overflow-hidden rounded border border-current/10 bg-background/35">
      {children}

      {graphData.nodes.length === 0 && !loading ? (
        <div className="flex h-full min-h-[680px] flex-col items-center justify-center text-foreground/40">
          <Database className="mb-3 h-10 w-10 opacity-40" />
          <p>No memory nodes found.</p>
        </div>
      ) : (
        <ForceGraph2D<GraphNode, GraphLink>
          ref={graphRef}
          graphData={graphData}
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
          linkCanvasObjectMode={() => (showEdgeLabels ? "after" : undefined)}
          linkCanvasObject={(link, ctx, globalScale) => {
            if (!showEdgeLabels) return;
            const source = typeof link.source === "string" ? null : link.source;
            const target = typeof link.target === "string" ? null : link.target;
            if (!source || !target || typeof source.x !== "number" || typeof source.y !== "number" || typeof target.x !== "number" || typeof target.y !== "number") return;
            const x = (source.x + target.x) / 2;
            const y = (source.y + target.y) / 2;
            const fontSize = Math.max(7, 10 / globalScale);
            const label = link.kind.replace(/_/g, " ");
            ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const metrics = ctx.measureText(label);
            const padX = 3 / globalScale;
            const padY = 2 / globalScale;
            ctx.fillStyle = "rgba(2, 6, 23, 0.72)";
            ctx.fillRect(x - metrics.width / 2 - padX, y - fontSize / 2 - padY, metrics.width + padX * 2, fontSize + padY * 2);
            ctx.fillStyle = "rgba(226, 232, 240, 0.78)";
            ctx.fillText(label, x, y);
          }}
          onNodeClick={(node) => onNodeSelect(node.id)}
          onNodeHover={(node) => {
            onNodeHover(node?.id ?? null);
            document.body.style.cursor = node ? "pointer" : "default";
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const isSelected = node.id === selectedNodeId;
            const isHovered = node.id === hoveredNodeId;
            const isAnchor = node.kind === "profile" || node.kind === "wiki_root" || node.kind === "honcho_workspace";
            const shouldLabel = isSelected || isHovered || (nodeLabelDensity === "balanced" && (isAnchor || globalScale > 2.1)) || (nodeLabelDensity === "minimal" && (isAnchor || globalScale > 3.2)) || (nodeLabelDensity === "dense" && (isAnchor || globalScale > 1.15 || (node.visibleDegree ?? 0) >= 3));
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

      {graphData.nodes.length > 0 && (
        <div className="absolute right-3 top-16 z-10 max-h-64 w-[min(26rem,calc(100%-1.5rem))] overflow-auto rounded border border-current/10 bg-background/90 p-2 shadow-xl backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1 text-[0.65rem] uppercase tracking-widest text-foreground/40">
            <span>Nodes</span>
            <span>{graphData.nodes.length}/{totalNodeCount} · {graphData.links.length}/{totalEdgeCount} edges</span>
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {graphData.nodes.map((node) => (
              <button
                key={node.id}
                onClick={() => focusNode(node.id)}
                onMouseEnter={() => onNodeHover(node.id)}
                onMouseLeave={() => onNodeHover(null)}
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
  );
}
