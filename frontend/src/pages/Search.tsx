import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, Home, Loader2 } from "lucide-react";
import { api, ApiError } from "../api";
import type { SearchResult } from "../types";
import DocumentRow from "../components/DocumentRow";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get("q") || "";
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .search(q)
      .then((r) => setResults(r.results))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Search failed"))
      .finally(() => setLoading(false));
  }, [q]);

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-1 text-sm text-panda-muted flex-wrap">
        <Link to="/" className="flex items-center gap-1 hover:text-panda-accent">
          <Home size={14} /> Library
        </Link>
        <span className="flex items-center gap-1">
          <ChevronRight size={14} />
          <span className="text-panda-text font-medium">Search</span>
        </span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold">Search results</h1>
        {q && <p className="text-panda-muted text-sm mt-1">for “{q}”</p>}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-panda-muted text-sm">
          <Loader2 className="animate-spin" size={16} /> Searching across all channel-bound collections…
        </div>
      )}

      {error && <ErrorBanner message={error} />}

      {!loading && results && results.length === 0 && q && (
        <EmptyState title={`No documents matched "${q}"`} hint="Try a different keyword, or check that the relevant channel is joined in Settings." />
      )}

      {results && results.length > 0 && (
        <div className="flex flex-col gap-2">
          {results.map((r) => (
            <div key={`${r.collection.id}-${r.document.id}`} className="flex flex-col gap-1">
              <span className="text-xs text-panda-muted pl-1">{r.collection.name}</span>
              <DocumentRow doc={r.document} channelName={r.channel.name} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
