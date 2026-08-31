import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ExternalLink, Home, LayoutGrid, List, Loader2, RefreshCw, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { DocumentOut, Collection, GroupSummary, HealthTotals, Source } from "../types";
import { isPlaylist } from "../types";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { useStreamHealthFilter } from "../lib/useStreamHealthFilter";
import { useIntegrations } from "../integrations/IntegrationsContext";
import { telegramUrl } from "../lib/telegram";
import { findPath } from "../lib/collections";
import Breadcrumbs from "../components/Breadcrumbs";
import BackToTop from "../components/BackToTop";
import CollectionGrid from "../components/CollectionGrid";
import CopyLinkButton from "../components/CopyLinkButton";
import GroupedChannels from "../components/GroupedChannels";
import ItemRow from "../components/ItemRow";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import KeywordPills from "../components/KeywordPills";
import FileCount from "../components/FileCount";
import ScanProgress from "../components/ScanProgress";
import StatusBadge from "../components/StatusBadge";
import Tooltip from "../components/Tooltip";
import { useNotifications } from "../notifications/NotificationContext";

const PAGE_SIZE = 20;

/** " (1,204)" for a known count, "" for a state with none — an option
 *  reading "Not working" is better than one reading "Not working (0)". */
function count(n?: number): string {
  return n ? ` (${n.toLocaleString()})` : "";
}

export default function CollectionView() {
  const { collectionId = "" } = useParams();
  const { jobsBySource, jobsCompleted, healthJobs } = useNotifications();
  const { byId } = useIntegrations();
  const [tree, setTree] = useState<Collection[] | null>(null);
  const [docs, setDocs] = useState<DocumentOut[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // Grouped mode's data: real per-category counts from the server, not a
  // client-side tally over whatever page of `docs` happened to be loaded.
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [docErrors, setDocErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Mirrored into the `q` URL param (debounced, so typing doesn't spam
  // history) rather than kept purely local — a group card's link reads it
  // from here so the filter survives clicking into a category instead of
  // resetting to "all".
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const debouncedSearch = useDebouncedValue(search, 350);

  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (debouncedSearch) next.set("q", debouncedSearch);
        else next.delete("q");
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);
  // null = "the user hasn't chosen", so the default can depend on what
  // kind of collection this turns out to be once the tree loads.
  const [sort, setSort] = useState<string | null>(null);
  // Reachability filter. Only meaningful for m3u. Defaults to "Working" and,
  // unlike search/sort, carries across collections until the user changes it.
  const [health, setHealth] = useStreamHealthFilter();
  const [healthTotals, setHealthTotals] = useState<HealthTotals>({});
  // m3u only — grouped-by-category is the default, flat list is the fallback.
  const [viewMode, setViewMode] = useState<"grouped" | "list">("grouped");
  // Whether the last `groups` fetch found more than one category worth
  // showing. null = not checked yet. A playlist with no #EXTGRP/group-title
  // at all collapses to a single "" bucket — rendering that as a folder card
  // labelled "Other channels" the user has to click through is pure friction
  // for a source that was never actually categorized, so that case (and the
  // zero-groups case) falls back to the flat list as if grouping didn't exist.
  const [groupingAvailable, setGroupingAvailable] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.collections.tree().then(setTree).catch(() => {});
  }, [collectionId, jobsCompleted]);

  const path = useMemo(() => (tree ? findPath(tree, collectionId) : null), [tree, collectionId]);
  const node = path ? path[path.length - 1] : null;

  // A stream entry has no size and no download, and its playlist is re-fetched
  // rather than incrementally scanned — so the sorts, the copy and the refresh
  // affordance all differ.
  const isM3u = node?.sourceType === "m3u";

  const grouped = isM3u && viewMode === "grouped" && groupingAvailable !== false;
  // Every entry in a playlist snapshot carries the same fetch timestamp, so
  // date_desc would order by ordinal *descending* — the playlist backwards.
  // Ascending ordinals are the order the provider actually wrote.
  const effectiveSort = sort ?? (isM3u ? "date_asc" : "date_desc");

  async function loadDocs(refresh = false, searchOverride?: string) {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      const res = await api.collections.documents(collectionId, {
        search: (searchOverride ?? debouncedSearch) || undefined,
        sort: effectiveSort,
        refresh,
        offset: 0,
        limit: PAGE_SIZE,
        health: (isM3u && health) || undefined,
      });
      setDocs(res.documents);
      setTotal(res.total);
      setSources(res.sources);
      setDocErrors(res.errors ?? []);
      setHealthTotals(res.healthTotals ?? {});
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
        sort: effectiveSort,
        offset: docs.length,
        limit: PAGE_SIZE,
        health: (isM3u && health) || undefined,
      });
      setDocs((prev) => (prev ? [...prev, ...res.documents] : res.documents));
      setTotal(res.total);
    } catch {
      // leave what's loaded — scrolling back into view will retry
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadGroups(refresh = false, searchOverride?: string) {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      const res = await api.collections.groups(collectionId, {
        search: (searchOverride ?? debouncedSearch) || undefined,
        refresh,
        health: health || undefined,
      });
      setGroups(res.groups);
      setGroupingAvailable(res.groups.length > 1);
      setSources(res.sources);
      setDocErrors(res.errors ?? []);
      setHealthTotals(res.healthTotals ?? {});
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load categories");
      setGroups([]);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!node?.sourceIds.length) {
      setDocs(null);
      setTotal(null);
      setGroups(null);
      setSources([]);
      setDocErrors([]);
      return;
    }
    if (grouped) {
      setGroups(null);
      loadGroups();
    } else {
      setDocs(null);
      setTotal(null);
      loadDocs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, node?.sourceIds.length, grouped, effectiveSort, debouncedSearch, health, jobsCompleted]);

  // A source's category count is a property of that source, not of whatever
  // filter happens to be active — recheck it fresh per collection rather
  // than carrying a stale verdict (or a stale filtered-down one) across a
  // navigation.
  useEffect(() => setGroupingAvailable(null), [collectionId]);

  // Follow a running stream check. Only the tallies are re-read: re-fetching
  // the documents would replace an infinite-scrolled list with its first
  // page every few seconds. The dots on the rows themselves catch up when
  // the check finishes, which bumps jobsCompleted and reloads properly.
  useEffect(() => {
    if (!healthJobs.length || !isM3u || !node?.sourceIds.length) return;
    let cancelled = false;
    async function tick() {
      try {
        const res = await api.collections.health(collectionId);
        if (!cancelled) setHealthTotals(res.healthTotals ?? {});
      } catch {
        // transient — the next tick retries
      }
    }
    tick();
    const t = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [healthJobs.length, isM3u, collectionId, node?.sourceIds.length]);

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
    if (grouped) loadGroups(false, search);
    else loadDocs(false, search);
  }

  function onKeywordSelect(word: string) {
    setSearch(word);
    if (grouped) loadGroups(false, word);
    else loadDocs(false, word);
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
      <Breadcrumbs
        items={[
          { label: "Library", to: "/", icon: <Home size={14} /> },
          { label: byId(node.sourceType)?.name ?? node.sourceType, to: `/s/${node.sourceType}` },
          ...path!.map((p) => ({ label: p.name, to: `/c/${p.id}` })),
        ]}
      />

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{node.name}</h1>
          {node.description && <p className="text-panda-muted text-sm mt-1">{node.description}</p>}
        </div>
        {sources.length === 1 && (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
            <StatusBadge status={sources[0].status} job={jobsBySource[sources[0].id]} sourceType={node.sourceType} />
            <span className="text-xs text-panda-muted">{sources[0].name}</span>
            <FileCount count={sources[0].fileCount} />
            {isPlaylist(sources[0]) ? (
              <>
                <CopyLinkButton url={sources[0].url} label="Copy playlist URL" />
                <Tooltip label="Open the playlist file">
                  <a
                    href={sources[0].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-panda-muted hover:text-panda-accent"
                  >
                    <ExternalLink size={14} />
                  </a>
                </Tooltip>
              </>
            ) : (
              <>
                <CopyLinkButton url={telegramUrl(sources[0].channel)} />
                <Tooltip label={`Open ${sources[0].channel} on Telegram`}>
                  <a
                    href={telegramUrl(sources[0].channel)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-panda-muted hover:text-panda-accent"
                  >
                    <ExternalLink size={14} />
                  </a>
                </Tooltip>
              </>
            )}
            </div>
            {jobsBySource[sources[0].id] && (
              <div className="w-56">
                <ScanProgress job={jobsBySource[sources[0].id]} />
              </div>
            )}
          </div>
        )}
        {sources.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {sources.map((c) => (
              <span key={c.id} className="flex items-center gap-1 text-xs text-panda-muted bg-panda-surface2 rounded-full px-2 py-1">
                <StatusBadge status={c.status} job={jobsBySource[c.id]} sourceType={node.sourceType} />
                <span>{c.name}</span>
                <FileCount count={c.fileCount} />
                {isPlaylist(c) ? (
                  <>
                    <CopyLinkButton url={c.url} label="Copy playlist URL" size={12} />
                    <Tooltip label="Open the playlist file">
                      <a href={c.url} target="_blank" rel="noopener noreferrer" className="hover:text-panda-accent">
                        <ExternalLink size={12} />
                      </a>
                    </Tooltip>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} />}
      {docErrors.length > 0 && (
        <ErrorBanner message={`Some sources couldn't be reached: ${docErrors.join("; ")}`} />
      )}

      {!node.sourceIds.length && (
        <>
          {node.children.length === 0 ? (
            <EmptyState
              title="This collection is empty"
              hint={`Add sub-collections or bind a ${isM3u ? "playlist" : "channel"} to it from Settings.`}
            />
          ) : (
            <CollectionGrid collections={node.children} parentId={node.id} />
          )}
        </>
      )}

      {node.sourceIds.length > 0 && (
        <>
          <form
            onSubmit={onSearchSubmit}
            className="sticky top-[var(--header-h)] z-[5] -mx-4 flex flex-wrap items-center gap-2 bg-panda-bg/95 px-4 py-3 backdrop-blur"
          >
            <div className="relative flex-1 min-w-[200px]">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={isM3u ? "Filter channels in this collection…" : "Filter documents in this collection…"}
                className="w-full bg-panda-surface border border-panda-border rounded-lg pl-3 pr-8 py-2 text-sm outline-none focus:border-panda-accent"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-panda-muted hover:text-panda-text"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {isM3u && groupingAvailable !== false && (
              <div className="flex items-center overflow-hidden rounded-lg border border-panda-border text-sm">
                <Tooltip label="Cards grouped by category">
                  <button
                    type="button"
                    onClick={() => setViewMode("grouped")}
                    aria-pressed={viewMode === "grouped"}
                    className={`flex items-center gap-1.5 px-3 py-2 ${
                      viewMode === "grouped" ? "bg-panda-surface2 text-panda-accent" : "text-panda-muted hover:text-panda-text"
                    }`}
                  >
                    <LayoutGrid size={14} /> Grouped
                  </button>
                </Tooltip>
                <Tooltip label="Flat, sortable list">
                  <button
                    type="button"
                    onClick={() => setViewMode("list")}
                    aria-pressed={viewMode === "list"}
                    className={`flex items-center gap-1.5 px-3 py-2 border-l border-panda-border ${
                      viewMode === "list" ? "bg-panda-surface2 text-panda-accent" : "text-panda-muted hover:text-panda-text"
                    }`}
                  >
                    <List size={14} /> List
                  </button>
                </Tooltip>
              </div>
            )}
            {!grouped && (
              <select
                value={effectiveSort}
                onChange={(e) => setSort(e.target.value)}
                className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 text-sm outline-none focus:border-panda-accent"
              >
                {isM3u ? (
                  <option value="date_asc">Playlist order</option>
                ) : (
                  <>
                    <option value="date_desc">Newest first</option>
                    <option value="date_asc">Oldest first</option>
                  </>
                )}
                <option value="name_asc">Name A–Z</option>
                <option value="name_desc">Name Z–A</option>
                {/* Every entry's size is 0, so a size sort would be arbitrary;
                    group is the axis that actually means something here. */}
                {isM3u && <option value="group_asc">Group A–Z</option>}
                {isM3u && <option value="group_desc">Group Z–A</option>}
                {!isM3u && <option value="size_desc">Largest first</option>}
                {!isM3u && <option value="size_asc">Smallest first</option>}
              </select>
            )}
            {isM3u && healthJobs.length > 0 && (
              <span className="text-xs text-panda-muted self-center">
                Checking streams… counts update live
              </span>
            )}
            {isM3u && (
              <select
                value={health}
                onChange={(e) => setHealth(e.target.value)}
                title="Filter by whether the stream answered when it was last checked"
                className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 text-sm outline-none focus:border-panda-accent"
              >
                <option value="">All channels</option>
                <option value="available">Working{count(healthTotals.available)}</option>
                <option value="unavailable">Not working{count(healthTotals.unavailable)}</option>
                <option value="unknown">Didn't answer{count(healthTotals.unknown)}</option>
                <option value="unchecked">Not checked{count(healthTotals.unchecked)}</option>
              </select>
            )}
            <Tooltip label={isM3u ? "Re-fetch this playlist now" : "Check Telegram now for new files"}>
              <button
                type="button"
                onClick={() => (grouped ? loadGroups(true) : loadDocs(true))}
                disabled={refreshing}
                className="flex items-center gap-1.5 rounded-lg border border-panda-border px-3 py-2 text-sm hover:border-panda-accent disabled:opacity-50"
              >
                <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Refresh
              </button>
            </Tooltip>
          </form>

          <KeywordPills collectionId={collectionId} onSelect={onKeywordSelect} />

          {grouped ? (
            <>
              {groups === null && (
                <div className="flex items-center gap-2 text-panda-muted text-sm">
                  <Loader2 className="animate-spin" size={16} /> Loading categories…
                </div>
              )}
              {groups && groups.length === 0 && (
                <EmptyState
                  title="No categories found"
                  hint="Nothing here yet, or your filter didn't match any channel."
                />
              )}
              {groups && groups.length > 0 && (
                <GroupedChannels collectionId={collectionId} groups={groups} search={debouncedSearch} />
              )}
            </>
          ) : (
            <>
              {docs === null && (
                <div className="flex items-center gap-2 text-panda-muted text-sm">
                  <Loader2 className="animate-spin" size={16} /> Loading {isM3u ? "channels" : "documents"}…
                </div>
              )}

              {docs && docs.length === 0 && (
                <EmptyState
                  title={isM3u ? "No channels found" : "No documents found"}
                  hint={`Nothing here yet, or your filter didn't match — every word has to appear in the ${
                    isM3u ? "channel name" : "filename"
                  }.`}
                />
              )}

              {docs && docs.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-panda-muted">
                    Showing {docs.length} of {total ?? docs.length}
                  </p>
                  {docs.map((d) => (
                    <ItemRow
                      key={`${d.sourceId}-${d.id}`}
                      doc={d}
                      sourceName={sources.length > 1 ? sources.find((c) => c.id === d.sourceId)?.name : undefined}
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
        </>
      )}

      <BackToTop />
    </div>
  );
}
