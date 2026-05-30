import { type GraphMode } from "./types";

interface MemoryGraphSettingsProps {
  mode: GraphMode;
  onModeChange: (mode: GraphMode) => void;
  includeMessages: boolean;
  onIncludeMessagesChange: (include: boolean) => void;
}

export function MemoryGraphSettings({ mode, onModeChange, includeMessages, onIncludeMessagesChange }: MemoryGraphSettingsProps) {
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

      <label className="flex items-center gap-2 text-sm text-foreground/70">
        <input type="checkbox" checked={includeMessages} onChange={(e) => onIncludeMessagesChange(e.target.checked)} />
        Include Honcho messages
      </label>
      <p className="mt-1 text-xs text-foreground/35">Messages are graph-schema ready but intentionally hidden by default.</p>
    </>
  );
}
