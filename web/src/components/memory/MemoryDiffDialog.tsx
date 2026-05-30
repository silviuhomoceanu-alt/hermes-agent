interface MemoryDiffDialogProps {
  before: string;
  after: string;
}

export function MemoryDiffDialog({ before, after }: MemoryDiffDialogProps) {
  if (before === after) return null;
  return (
    <div className="rounded border border-current/10 bg-current/5 p-2">
      <div className="mb-2 text-[0.65rem] uppercase tracking-widest text-foreground/40">Diff preview</div>
      <div className="grid gap-2 text-[0.68rem] lg:grid-cols-2">
        <DiffPane title="Before" text={before} tone="destructive" />
        <DiffPane title="After" text={after} tone="midground" />
      </div>
    </div>
  );
}

function DiffPane({ title, text, tone }: { title: string; text: string; tone: "destructive" | "midground" }) {
  const lines = text.split("\n").slice(0, 80);
  return (
    <div className="rounded border border-current/10 bg-background/60 p-2">
      <div className={`mb-1 text-[0.65rem] uppercase tracking-widest ${tone === "destructive" ? "text-destructive" : "text-midground"}`}>{title}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[0.68rem] leading-relaxed text-foreground/70">
        {lines.join("\n") || "—"}
      </pre>
    </div>
  );
}
