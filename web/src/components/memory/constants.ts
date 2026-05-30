import type { MemoryNode } from "@/lib/api";

export const SOURCE_COLORS: Record<string, string> = {
  hermes: "#84cc16",
  honcho: "#d946ef",
  wiki: "#38bdf8",
  derived: "#f59e0b",
};

export const SOURCE_LABELS: Record<string, string> = {
  hermes: "Hermes",
  honcho: "Honcho",
  wiki: "LLM Wiki",
  derived: "Derived",
};

export function nodeSize(node: MemoryNode): number {
  if (node.kind === "profile" || node.kind === "wiki_root" || node.kind === "honcho_workspace") return 8;
  if (node.kind === "wiki_page" || node.kind === "honcho_peer") return 6;
  if (node.kind.includes("entry") || node.kind.includes("conclusion")) return 4.5;
  return 3.5;
}

export function metadataString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
