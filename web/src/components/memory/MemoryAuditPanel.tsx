import { useEffect, useState } from "react";
import { Clock, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { api, type MemoryAuditOperation } from "@/lib/api";

export function MemoryAuditPanel() {
  const [operations, setOperations] = useState<MemoryAuditOperation[]>([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.getMemoryAudit(20)
      .then((res) => setOperations(res.operations))
      .catch(() => setOperations([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="mt-4 rounded border border-current/10 bg-background/45 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4" /> Audit</div>
        <Button ghost size="sm" onClick={load} disabled={loading}>{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</Button>
      </div>
      {operations.length === 0 ? <p className="text-xs text-foreground/40">No write operations recorded yet.</p> : (
        <div className="space-y-1.5">
          {operations.map((op) => (
            <div key={op.id} className="rounded border border-current/10 bg-current/5 p-2 text-[0.68rem]">
              <div className="flex items-center justify-between gap-2">
                <span className={op.success ? "text-midground" : "text-destructive"}>{op.source}:{op.action}</span>
                <span className="font-mono text-foreground/35">{op.profile}</span>
              </div>
              <div className="mt-1 font-mono text-foreground/35">{op.timestamp}</div>
              {op.error && <div className="mt-1 text-destructive">{op.error}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
