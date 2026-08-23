import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, Home, Loader2 } from "lucide-react";
import { api, ApiError } from "../api";
import type { SearchResult } from "../types";
import { MIN_SEARCH_LENGTH, SEARCH_PAGE_SIZE } from "../lib/search";
import ItemRow from "../components/ItemRow";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get("q") || "";
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Bumped per query. `abort()` alone isn't enough — a response can already
  // be parsing when the abort lands, so results are also matched against
  // the generation that asked for them before being rendered.
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    if (q.trim().length < MIN_SEARCH_LENGTH) {
      setResults([]);
      setTotal(0);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .search(q, { offset: 0, limit: SEARCH_PAGE_SIZE, signal: controller.signal })
      .then((r) => {
        if (gen !== genRef.current) return;
        setResults(r.results);
        setTotal(r.total);
      })
      .catch((e) => {
        if (e?.name === "AbortError" || gen !== genRef.current) return;
        setError(e instanceof ApiError ? e.message : "Search failed");
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [q]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || results === null || results.length >= total) return;
    const gen = genRef.current;
    setLoadingMore(true);
    try {
      const r = await api.search(q, { offset: results.length, limit: SEARCH_PAGE_SIZE });
      if (gen !== genRef.current) return;
      setResults((prev) => (prev ? [...prev, ...r.results] : r.results));
      setTotal(r.total);
    } catch {
      // leave what's loaded — scrolling back into view will retry
    } finally {
      if (gen === genRef.current) setLoadingMore(false);
    }
  }, [q, loading, loadingMore, results, total]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: "300px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const tooShort = q.trim().length > 0 && q.trim().length < MIN_SEARCH_LENGTH;

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
        {results && results.length > 0 && (
          <p className="text-panda-muted text-sm mt-1">
            Showing {results.length} of {total.toLocaleString()}
          </p>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-panda-muted text-sm">
          <Loader2 className="animate-spin" size={16} /> Searching across every collection…
        </div>
      )}

      {error && <ErrorBanner message={error} />}

      {tooShort && (
        <EmptyState
          title={`Keep typing — at least ${MIN_SEARCH_LENGTH} characters`}
          hint="A single character matches almost everything in the library."
        />
      )}

      {!loading && !tooShort && results && results.length === 0 && q && (
        <EmptyState title={`No documents matched "${q}"`} hint="Every word has to appear in the filename, so try fewer words — or check that the relevant channel is joined in Settings." />
      )}

      {results && results.length > 0 && (
        <div className="flex flex-col gap-2">
          {results.map((r) => (
            <div key={`${r.sourceId}-${r.document.id}`} className="flex flex-col gap-1">
              <span className="text-xs text-panda-muted pl-1">{r.collectionName}</span>
              <ItemRow doc={r.document} sourceName={r.sourceName} />
            </div>
          ))}
        </div>
      )}

      <div ref={sentinelRef} />

      {loadingMore && (
        <div className="flex items-center gap-2 text-panda-muted text-sm">
          <Loader2 className="animate-spin" size={16} /> Loading more…
        </div>
      )}
    </div>
  );
}
