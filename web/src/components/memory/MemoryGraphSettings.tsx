import { type GraphDensitySettings, type GraphMode, type NodeLabelDensity } from "./types";

interface MemoryGraphSettingsProps {
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  settings: GraphDensitySettings;
  onSettingsChange: (settings: GraphDensitySettings) => void;
}

const maxNodeOptions = [50, 100, 200, 500, 1000];
const labelDensityOptions: Array<{ value: NodeLabelDensity; label: string }> = [
  { value: "minimal", label: "Minimal" },
  { value: "balanced", label: "Balanced" },
  { value: "dense", label: "Dense" },
];

export function MemoryGraphSettings({ mode, onModeChange, settings, onSettingsChange }: MemoryGraphSettingsProps) {
  const update = <K extends keyof GraphDensitySettings>(key: K, value: GraphDensitySettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <>
      <label className="mb-1 block text-xs uppercase tracking-widest text-foreground/40">Graph mode</label>
      <div className="mb-4 grid grid-cols-2 gap-1 rounded bg-current/5 p-1">
        {(["global", "local"] as GraphMode[]).map((m) => (
          <button key={m} onClick={() => onModeChange(m)} className={`rounded px-2 py-1.5 text-xs capitalize ${mode === m ? "bg-background text-midground shadow" : "text-foreground/55"}`}>
            {m}
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-3">
        <label className="grid gap-1 text-xs text-foreground/55">
          <span className="uppercase tracking-widest text-foreground/40">Max nodes</span>
          <select
            value={settings.maxNodes}
            onChange={(e) => update("maxNodes", Number(e.target.value))}
            className="w-full rounded border border-current/15 bg-background px-2 py-2 text-sm text-foreground"
          >
            {maxNodeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>

        <label className="grid gap-1 text-xs text-foreground/55">
          <span className="uppercase tracking-widest text-foreground/40">Local depth</span>
          <input
            type="range"
            min={1}
            max={4}
            value={settings.localDepth}
            onChange={(e) => update("localDepth", Number(e.target.value))}
          />
          <span>{settings.localDepth}-hop neighborhood</span>
        </label>

        <label className="grid gap-1 text-xs text-foreground/55">
          <span className="uppercase tracking-widest text-foreground/40">Node labels</span>
          <select
            value={settings.nodeLabelDensity}
            onChange={(e) => update("nodeLabelDensity", e.target.value as NodeLabelDensity)}
            className="w-full rounded border border-current/15 bg-background px-2 py-2 text-sm text-foreground"
          >
            {labelDensityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      <div className="grid gap-2 text-sm text-foreground/70">
        <Toggle checked={settings.includeDerivedEdges} onChange={(checked) => update("includeDerivedEdges", checked)} label="Derived mention edges" />
        <Toggle checked={settings.includeRawSources} onChange={(checked) => update("includeRawSources", checked)} label="Raw wiki sources" />
        <Toggle checked={settings.includeMessages} onChange={(checked) => update("includeMessages", checked)} label="Honcho messages" />
        <Toggle checked={settings.showEdgeLabels} onChange={(checked) => update("showEdgeLabels", checked)} label="Edge labels" />
      </div>
      <p className="mt-2 text-xs text-foreground/35">Raw sources and Honcho messages reload the graph. Local depth applies when a node is selected.</p>
    </>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
