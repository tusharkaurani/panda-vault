import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronRight, ExternalLink, Home, Loader2, RefreshCw } from "lucide-react";
import { api, ApiError } from "../api";
import type { DocumentOut, Channel, Collection } from "../types";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { telegramUrl } from "../lib/telegram";
import BackToTop from "../components/BackToTop";
import CollectionGrid from "../components/CollectionGrid";
import CopyLinkButton from "../components/CopyLinkButton";
import DocumentRow from "../components/DocumentRow";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import KeywordPills from "../components/KeywordPills";
import FileCount from "../components/FileCount";
import ScanProgress from "../components/ScanProgress";
import StatusBadge from "../components/StatusBadge";
import Tooltip from "../components/Tooltip";
import { useNotifications } from "../notifications/NotificationContext";

const PAGE_SIZE = 20;

function findPath(nodes: Collection[], id: string, trail: Collection[] = []): Collection[] | null {
  for (const n of nodes) {
    const next = [...trail, n];
    if (n.id === id) return next;
    if (n.children.length) {
      const found = findPath(n.children, id, next);
      if (found) return found;
    }
  }
  return null;
}

export default function CollectionView() {
  const { collectionId = "" } = useParams();
  const { jobsByChannel, jobsCompleted } = useNotifications();
  const [tree, setTree] = useState<Collection[] | null>(null);
  const [docs, setDocs] = useState<DocumentOut[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [docErrors, setDocErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 350);
  const [sort, setSort] = useState("date_desc");
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.collections.tree().then(setTree).catch(() => {});
  }, [collectionId, jobsCompleted]);

  const path = useMemo(() => (tree ? findPath(tree, collectionId) : null), [tree, collectionId]);
  const node = path ? path[path.length - 1] : null;

  async function loadDocs(refresh = false, searchOverride?: string) {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      const res = await api.collections.documents(collectionId, {
        search: (searchOverride ?? debouncedSearch) || undefined,
        sort,
        refresh,
        offset: 0,
        limit: PAGE_SIZE,
      });
      setDocs(res.documents);
      setTotal(res.total);
      setChannels(res.channels);
      setDocErrors(res.errors ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load documents");
      setDocs([]);
      setTotal(0);
    } finally {
      setRefreshing(false);
    }
  }

  async function loadMore() {
    if (loadingMore || docs === null || total === null || docs.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await api.collections.documents(collectionId, {
        search: debouncedSearch || undefined,
        sort,
        offset: docs.length,
        limit: PAGE_SIZE,
      });
      setDocs((prev) => (prev ? [...prev, ...res.documents] : res.documents));
      setTotal(res.total);
    } catch {
      // leave what's loaded — scrolling back into view will retry
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (node?.channelIds.length) {
      setDocs(null);
      setTotal(null);
      loadDocs();
    } else {
      setDocs(null);
      setTotal(null);
      setChannels([]);
      setDocErrors([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, node?.channelIds.length, sort, debouncedSearch, jobsCompleted]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, total, loadingMore]);

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    loadDocs(false, search);
  }

  function onKeywordSelect(word: string) {
    setSearch(word);
    loadDocs(false, word);
  }

  if (!tree) {
    return (
      <div className="flex items-center gap-2 text-panda-muted text-sm py-10">
        <Loader2 className="animate-spin" size={16} /> Loading…
      </div>
    );
  }

  if (!node) {
    return <ErrorBanner message="Collection not found. It may have been deleted or moved." />;
  }

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-1 text-sm text-panda-muted flex-wrap">
        <Link to="/" className="flex items-center gap-1 hover:text-panda-accent">
          <Home size={14} /> Library
        </Link>
        {path!.map((p) => (
          <span key={p.id} className="flex items-center gap-1">
            <ChevronRight size={14} />
            <Link to={`/c/${p.id}`} className={p.id === node.id ? "text-panda-text font-medium" : "hover:text-panda-accent"}>
              {p.name}
            </Link>
          </span>
        ))}
      </nav>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{node.name}</h1>
          {node.description && <p className="text-panda-muted text-sm mt-1">{node.description}</p>}
        </div>
        {channels.length === 1 && (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
            <StatusBadge status={channels[0].status} job={jobsByChannel[channels[0].id]} />
            <span className="text-xs text-panda-muted">{channels[0].name}</span>
            <FileCount count={channels[0].fileCount} />
            <CopyLinkButton url={telegramUrl(channels[0].channel)} />
            <Tooltip label={`Open ${channels[0].channel} on Telegram`}>
              <a
                href={telegramUrl(channels[0].channel)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-panda-muted hover:text-panda-accent"
              >
                <ExternalLink size={14} />
              </a>
            </Tooltip>
            </div>
            {jobsByChannel[channels[0].id] && (
              <div className="w-56">
                <ScanProgress job={jobsByChannel[channels[0].id]} />
              </div>
            )}
          </div>
        )}
        {channels.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {channels.map((c) => (
              <span key={c.id} className="flex items-center gap-1 text-xs text-panda-muted bg-panda-surface2 rounded-full px-2 py-1">
                <StatusBadge status={c.status} job={jobsByChannel[c.id]} />
                <span>{c.name}</span>
                <FileCount count={c.fileCount} />
                <CopyLinkButton url={telegramUrl(c.channel)} size={12} />
                <Tooltip label={`Open ${c.channel} on Telegram`}>
                  <a
                    href={telegramUrl(c.channel)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-panda-accent"
                  >
                    <ExternalLink size={12} />
                  </a>
                </Tooltip>
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} />}
      {docErrors.length > 0 && (
        <ErrorBanner message={`Some channels couldn't be reached: ${docErrors.join("; ")}`} />
      )}

      {!node.channelIds.length && (
        <>
          {node.children.length === 0 ? (
            <EmptyState title="This collection is empty" hint="Add sub-collections or bind a channel to it from Settings." />
          ) : (
            <CollectionGrid collections={node.children} parentId={node.id} />
          )}
        </>
      )}

      {node.channelIds.length > 0 && (
        <>
          <form onSubmit={onSearchSubmit} className="flex items-center gap-2 flex-wrap">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter documents in this collection…"
              className="flex-1 min-w-[200px] bg-panda-surface border border-panda-border rounded-lg px-3 py-2 text-sm outline-none focus:border-panda-accent"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 text-sm outline-none focus:border-panda-accent"
            >
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="name_asc">Name A–Z</option>
              <option value="name_desc">Name Z–A</option>
              <option value="size_desc">Largest first</option>
              <option value="size_asc">Smallest first</option>
            </select>
            <Tooltip label="Check Telegram now for new files">
              <button
                type="button"
                onClick={() => loadDocs(true)}
                disabled={refreshing}
                className="flex items-center gap-1.5 rounded-lg border border-panda-border px-3 py-2 text-sm hover:border-panda-accent disabled:opacity-50"
              >
                <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Refresh
              </button>
            </Tooltip>
          </form>

          <KeywordPills collectionId={collectionId} onSelect={onKeywordSelect} />

          {docs === null && (
            <div className="flex items-center gap-2 text-panda-muted text-sm">
              <Loader2 className="animate-spin" size={16} /> Loading documents…
            </div>
          )}

          {docs && docs.length === 0 && (
            <EmptyState title="No documents found" hint="Nothing here yet, or your filter didn't match — every word has to appear in the filename." />
          )}

          {docs && docs.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-panda-muted">
                Showing {docs.length} of {total ?? docs.length}
              </p>
              {docs.map((d) => (
                <DocumentRow
                  key={`${d.channelId}-${d.id}`}
                  doc={d}
                  channelName={channels.length > 1 ? channels.find((c) => c.id === d.channelId)?.name : undefined}
                />
              ))}
              {total !== null && docs.length < total && (
                <div ref={sentinelRef} className="flex items-center justify-center gap-2 text-panda-muted text-sm py-4">
                  <Loader2 className="animate-spin" size={16} /> Loading more…
                </div>
              )}
            </div>
          )}
        </>
      )}

      <BackToTop />
    </div>
  );
}
