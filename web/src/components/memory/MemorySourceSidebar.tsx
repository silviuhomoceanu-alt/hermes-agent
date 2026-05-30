import { GitBranch } from "lucide-react";
import type { MemoryEdge, MemoryGraphView, MemoryNode, MemoryProfileInfo } from "@/lib/api";
import { SOURCE_COLORS, SOURCE_LABELS } from "./constants";
import { MemoryGraphSettings } from "./MemoryGraphSettings";
import { MemoryAuditPanel } from "./MemoryAuditPanel";
import { MemoryCurationReviewPanel } from "./MemoryCurationReviewPanel";
import type { GraphDensitySettings, GraphMode, SourceFilter } from "./types";

interface MemorySourceSidebarProps {
  profiles: MemoryProfileInfo[];
  selectedProfile: string;
  onSelectedProfileChange: (profile: string) => void;
  sourceFilter: SourceFilter;
  onSourceFilterChange: (source: SourceFilter) => void;
  graphView: MemoryGraphView;
  onGraphViewChange: (view: MemoryGraphView) => void;
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  densitySettings: GraphDensitySettings;
  onDensitySettingsChange: (settings: GraphDensitySettings) => void;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  onFocusNode: (id: string) => void;
}

export function MemorySourceSidebar({
  profiles,
  selectedProfile,
  onSelectedProfileChange,
  sourceFilter,
  onSourceFilterChange,
  graphView,
  onGraphViewChange,
  mode,
  onModeChange,
  densitySettings,
  onDensitySettingsChange,
  nodes,
  edges,
  onFocusNode,
}: MemorySourceSidebarProps) {
  return (
    <aside className="rounded border border-current/10 bg-background/45 p-3">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <GitBranch className="h-4 w-4" /> Sources
      </div>
      <label className="mb-1 block text-xs uppercase tracking-widest text-foreground/40">Profile</label>
      <select
        value={selectedProfile}
        onChange={(e) => onSelectedProfileChange(e.target.value)}
        className="mb-4 w-full rounded border border-current/15 bg-background px-2 py-2 text-sm"
      >
        <option value="all">All profiles</option>
        {profiles.map((profile) => (
          <option value={profile.name} key={profile.name}>{profile.name}</option>
        ))}
      </select>

      <label className="mb-1 block text-xs uppercase tracking-widest text-foreground/40">View</label>
      <div className="mb-4 grid grid-cols-2 rounded border border-current/15 bg-background/60 p-1 text-xs">
        {([
          ["stored_content", "Stored Content"],
          ["storage", "Storage Structure"],
        ] as const).map(([view, label]) => (
          <button
            key={view}
            type="button"
            onClick={() => onGraphViewChange(view)}
            className={`rounded px-2 py-1.5 text-center transition-colors ${graphView === view ? "bg-midground text-background" : "text-foreground/55 hover:bg-current/5 hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="mb-1 block text-xs uppercase tracking-widest text-foreground/40">Source</label>
      <div className="mb-4 grid gap-1">
        {(["all", "hermes", "honcho", "wiki"] as SourceFilter[]).map((source) => (
          <button
            key={source}
            onClick={() => onSourceFilterChange(source)}
            className={`flex items-center justify-between rounded px-2 py-2 text-left text-sm transition-colors ${sourceFilter === source ? "bg-midground/15 text-midground" : "hover:bg-current/5"}`}
          >
            <span>{source === "all" ? "All sources" : SOURCE_LABELS[source]}</span>
            {source !== "all" && <span className="h-2.5 w-2.5 rounded-full" style={{ background: SOURCE_COLORS[source] }} />}
          </button>
        ))}
      </div>

      <MemoryGraphSettings
        mode={mode}
        onModeChange={onModeChange}
        settings={densitySettings}
        onSettingsChange={onDensitySettingsChange}
      />

      <div className="mt-6 space-y-2 text-xs text-foreground/45">
        <LegendItem color={SOURCE_COLORS.hermes} label="Hermes hot memory" />
        <LegendItem color={SOURCE_COLORS.honcho} label="Honcho" />
        <LegendItem color={SOURCE_COLORS.wiki} label="LLM Wiki" />
        <LegendItem color={SOURCE_COLORS.derived} label="Derived mentions" />
      </div>

      <MemoryCurationReviewPanel nodes={nodes} edges={edges} onFocus={onFocusNode} />

      <MemoryAuditPanel />
    </aside>
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
