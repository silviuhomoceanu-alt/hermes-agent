import type { MemoryEdge, MemoryNode } from "@/lib/api";

export type SourceFilter = "all" | "hermes" | "honcho" | "wiki";
export type GraphMode = "global" | "local";

export type GraphNode = MemoryNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  val?: number;
  color?: string;
};

export type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
  kind: string;
  id: string;
  color?: string;
};

export type VisibleMemoryGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
};

export type MemoryRelationship = {
  edge: MemoryEdge;
  other: MemoryNode;
};
