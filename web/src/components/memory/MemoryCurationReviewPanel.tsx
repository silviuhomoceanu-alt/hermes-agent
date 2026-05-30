import { useMemo, useState } from "react";
import { AlertTriangle, Filter, Link2, ShieldCheck } from "lucide-react";
import type { MemoryEdge, MemoryNode } from "@/lib/api";
import { metadataString } from "./constants";

type ReviewFilter = "duplicates" | "conflicts" | "orphans" | "verbose" | "stale";

interface MemoryCurationReviewPanelProps {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  onFocus: (id: string) => void;
}

interface ReviewCandidate {
  id: string;
  node: MemoryNode;
  filter: ReviewFilter;
  reason: string;
  actions: string[];
}

const FILTERS: Array<{ id: ReviewFilter; label: string }> = [
  { id: "duplicates", label: "Duplicates" },
  { id: "conflicts", label: "Conflicts" },
  { id: "orphans", label: "Orphan wiki" },
  { id: "verbose", label: "Verbose hot memory" },
  { id: "stale", label: "Stale / low confidence" },
];

export function MemoryCurationReviewPanel({ nodes, edges, onFocus }: MemoryCurationReviewPanelProps) {
  const [filter, setFilter] = useState<ReviewFilter>("duplicates");
  const candidates = useMemo(() => buildReviewCandidates(nodes, edges), [nodes, edges]);
  const visible = candidates.filter((candidate) => candidate.filter === filter).slice(0, 12);
  const counts = useMemo(() => {
    const tally = new Map<ReviewFilter, number>();
    for (const candidate of candidates) tally.set(candidate.filter, (tally.get(candidate.filter) ?? 0) + 1);
    return tally;
  }, [candidates]);

  return (
    <section className="mt-6 rounded border border-current/10 bg-current/[0.025] p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Filter className="h-4 w-4" /> Curation review
      </div>
      <p className="mb-3 text-xs leading-relaxed text-foreground/45">
        Non-destructive candidate queue. Actions open the relevant node; writes still go through the editor, promote/demote, link, or delete confirmation flows.
      </p>
      <div className="mb-3 grid gap-1">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            onClick={() => setFilter(item.id)}
            className={`flex items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors ${filter === item.id ? "bg-midground/15 text-midground" : "hover:bg-current/5"}`}
          >
            <span>{item.label}</span>
            <span className="font-mono text-[0.65rem] text-foreground/45">{counts.get(item.id) ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded border border-current/10 p-3 text-xs text-foreground/45">
          <ShieldCheck className="mb-2 h-4 w-4 opacity-60" /> No candidates for this filter.
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((candidate) => (
            <button
              key={candidate.id}
              onClick={() => onFocus(candidate.node.id)}
              className="block w-full rounded border border-current/10 p-2 text-left text-xs hover:bg-current/5"
            >
              <div className="mb-1 flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground/80">{candidate.node.label}</div>
                  <div className="mt-0.5 text-foreground/45">{candidate.reason}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {candidate.actions.map((action) => (
                  <span key={action} className="rounded border border-current/10 px-1.5 py-0.5 text-[0.62rem] uppercase tracking-wide text-foreground/45">
                    {action}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-[0.68rem] text-foreground/40">
        <Link2 className="h-3 w-3" /> Link/promote/demote suggestions use draft-first APIs; destructive deletes remain confirm-gated.
      </div>
    </section>
  );
}

function buildReviewCandidates(nodes: MemoryNode[], edges: MemoryEdge[]): ReviewCandidate[] {
  const candidates: ReviewCandidate[] = [];
  const contentByKey = new Map<string, MemoryNode[]>();
  for (const node of nodes) {
    const content = nodeText(node);
    const normalized = normalizeContent(content);
    if (normalized.length > 24 && node.editable) {
      const bucket = contentByKey.get(normalized) ?? [];
      bucket.push(node);
      contentByKey.set(normalized, bucket);
    }
  }
  for (const duplicateNodes of contentByKey.values()) {
    if (duplicateNodes.length < 2) continue;
    for (const node of duplicateNodes) {
      candidates.push(candidate(node, "duplicates", "Same normalized content appears in multiple editable memory nodes.", ["keep", "edit", "link", "delete"]));
    }
  }

  const linkedWikiIds = new Set<string>();
  for (const edge of edges) {
    if (["wikilink", "backlink", "manual_link", "curated_link", "mentions"].includes(edge.kind)) {
      linkedWikiIds.add(edge.from);
      linkedWikiIds.add(edge.to);
    }
  }

  for (const node of nodes) {
    const text = nodeText(node);
    const lower = text.toLowerCase();
    if (node.kind === "wiki_page" && !linkedWikiIds.has(node.id) && !String(node.metadata?.path ?? "").endsWith("index.md")) {
      candidates.push(candidate(node, "orphans", "Wiki page has no visible wikilinks, backlinks, manual links, or derived mentions.", ["keep", "edit", "link", "promote"]));
    }
    if ((node.kind === "hermes_user_entry" || node.kind === "hermes_memory_entry") && wordCount(text) >= 45) {
      candidates.push(candidate(node, "verbose", "Hot-memory entry is long enough to consider demoting to the Wiki with a compact pointer.", ["keep", "edit", "demote", "delete"]));
    }
    if (/\b(conflict|contradict|contradicts|inconsistent|deprecated|superseded)\b/i.test(text)) {
      candidates.push(candidate(node, "conflicts", "Text carries conflict/deprecation language and should be reconciled manually.", ["keep", "edit", "link", "delete"]));
    }
    if (/\b(maybe|probably|possibly|low confidence|stale|unverified|todo|tbd)\b/i.test(lower)) {
      candidates.push(candidate(node, "stale", "Text contains uncertainty, stale, or TODO language.", ["keep", "edit", "promote", "delete"]));
    }
  }
  return dedupeCandidates(candidates);
}

function candidate(node: MemoryNode, filter: ReviewFilter, reason: string, actions: string[]): ReviewCandidate {
  return { id: `${filter}:${node.id}`, node, filter, reason, actions };
}

function nodeText(node: MemoryNode): string {
  return metadataString(node.metadata?.content || node.summary || node.metadata?.body || node.label || "");
}

function normalizeContent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function dedupeCandidates(candidates: ReviewCandidate[]): ReviewCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}
