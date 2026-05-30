import { useCallback, useEffect, useState } from "react";
import { Download, FileText, RefreshCw, FolderOpen } from "lucide-react";
import { api } from "@/lib/api";
import type { ReportFile } from "@/lib/api";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { usePageHeader } from "@/contexts/usePageHeader";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EXT_COLORS: Record<string, string> = {
  html: "text-orange-400",
  pdf: "text-red-400",
  csv: "text-green-400",
  xlsx: "text-emerald-400",
  png: "text-blue-400",
  svg: "text-purple-400",
  md: "text-sky-400",
  txt: "text-foreground/60",
};

function ExtBadge({ ext }: { ext: string }) {
  const color = EXT_COLORS[ext] ?? "text-foreground/60";
  return (
    <span
      className={`font-mono text-[0.65rem] font-bold uppercase tracking-widest ${color} bg-current/10 px-1.5 py-0.5 rounded`}
    >
      {ext}
    </span>
  );
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setEnd } = usePageHeader();

  const fetchReports = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getReports()
      .then((res) => setReports(res.reports))
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  useEffect(() => {
    setEnd(
      <Button ghost size="sm" onClick={fetchReports} disabled={loading}>
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        <span className="ml-1.5 hidden sm:inline">Refresh</span>
      </Button>,
    );
    return () => setEnd(null);
  }, [fetchReports, loading, setEnd]);

  // Group by directory for display
  const grouped = reports.reduce<Record<string, ReportFile[]>>((acc, r) => {
    // Use just the last two path segments
    const parts = r.dir.replace(/\/$/, "").split("/");
    const key = parts.slice(-2).join("/");
    (acc[key] ??= []).push(r);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <p className="text-xs uppercase tracking-widest opacity-40 mb-1">Reports</p>
        <h1 className="text-xl font-bold tracking-tight">Generated Reports</h1>
        <p className="text-sm text-foreground/50 mt-1">
          HTML, PDF, CSV and other output files — click to preview or download.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && reports.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-foreground/50 py-8 justify-center">
          <Spinner />
          Loading reports…
        </div>
      )}

      {/* Empty state */}
      {!loading && reports.length === 0 && !error && (
        <div className="flex flex-col items-center gap-3 py-16 text-foreground/40">
          <FileText className="h-10 w-10 opacity-30" />
          <p className="text-sm">No reports found yet.</p>
          <p className="text-xs max-w-xs text-center">
            Reports land here automatically when the agent writes HTML, PDF, CSV or
            other output files to{" "}
            <code className="font-mono text-[0.7rem]">~/Downloads</code>,{" "}
            <code className="font-mono text-[0.7rem]">~/.hermes/outputs</code>, or{" "}
            <code className="font-mono text-[0.7rem]">~/.hermes/reports</code>.
          </p>
        </div>
      )}

      {/* Report groups */}
      {Object.entries(grouped).map(([dirLabel, files]) => (
        <section key={dirLabel}>
          <div className="flex items-center gap-2 mb-2 opacity-50">
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="text-xs font-mono tracking-wide">{dirLabel}</span>
          </div>
          <div className="rounded border border-current/10 overflow-hidden divide-y divide-current/10">
            {files.map((report) => (
              <ReportRow key={report.path} report={report} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ReportRow({ report }: { report: ReportFile }) {
  const downloadUrl = api.getReportDownloadUrl(report.path);

  const handleOpen = () => {
    // Open HTML reports in a new tab for preview; everything else downloads
    if (report.ext === "html") {
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
    } else {
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = report.name;
      a.click();
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = report.name;
    a.click();
  };

  return (
    <div
      className="group flex items-center gap-4 px-4 py-3 hover:bg-midground/5 cursor-pointer transition-colors"
      onClick={handleOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && handleOpen()}
    >
      {/* Icon */}
      <FileText className="h-4 w-4 shrink-0 opacity-40" />

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{report.name}</span>
          <ExtBadge ext={report.ext} />
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-foreground/40">
          <span>{formatDate(report.modified)}</span>
          <span>·</span>
          <span>{formatBytes(report.size_bytes)}</span>
        </div>
      </div>

      {/* Download button */}
      <Button
        ghost
        size="icon"
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleDownload}
        title="Download"
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
