import { Search } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import type { MemorySearchResult } from "@/lib/api";
import { SOURCE_COLORS } from "./constants";

interface MemorySearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: MemorySearchResult[];
  loading: boolean;
  onFocusResult: (id: string) => void;
  onClearResults: () => void;
}

export function MemorySearch({ query, onQueryChange, results, loading, onFocusResult, onClearResults }: MemorySearchProps) {
  return (
    <>
      <div className="absolute left-3 right-3 top-3 z-10 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-foreground/35" />
          <Input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Search memory across Hermes, Honcho, Wiki…" className="pl-8" />
        </div>
        {loading && <div className="flex items-center gap-2 rounded border border-current/10 bg-background/80 px-3 text-xs"><Spinner /> Loading</div>}
      </div>

      {results.length > 0 && (
        <div className="absolute left-3 top-14 z-20 max-h-72 w-[min(680px,calc(100%-1.5rem))] overflow-auto rounded border border-current/10 bg-background/95 p-2 shadow-xl backdrop-blur">
          {results.map((result) => (
            <button
              key={result.id}
              className="block w-full rounded px-3 py-2 text-left hover:bg-current/5"
              onClick={() => {
                onFocusResult(result.id);
                onClearResults();
              }}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="h-2 w-2 rounded-full" style={{ background: SOURCE_COLORS[result.source] ?? "#94a3b8" }} />
                {result.title}
                <Badge tone="outline" className="text-[0.65rem]">{result.kind}</Badge>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-foreground/45">{result.snippet}</p>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
