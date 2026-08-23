import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Home, Loader2 } from "lucide-react";
import { api, ApiError } from "../api";
import type { Collection, DocumentOut, HealthTotals } from "../types";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { useIntegrations } from "../integrations/IntegrationsContext";
import { findPath } from "../lib/collections";
import { groupParamFromUrl } from "../components/GroupedChannels";
import Breadcrumbs from "../components/Breadcrumbs";
import BackToTop from "../components/BackToTop";
import ChannelTile from "../components/ChannelTile";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";

const PAGE_SIZE = 40;

function count(n?: number): string {
  return n ? ` (${n.toLocaleString()})` : "";
}

/** One category's own page — everything tagged with it, across the whole
 *  collection, not just whatever page happened to be loaded on the overview.
 *  A sibling of CollectionView rather than a mode of it: the data shape is
 *  simpler (no sort choice, no Grouped/List toggle) and the tiles are the
 *  point, not a summary. */
export default function GroupChannelsView() {
  const { collectionId = "", group: groupSlug = "" } = useParams();
  const group = groupParamFromUrl(groupSlug);
  const { byId } = useIntegrations();
  const [tree, setTree] = useState<Collection[] | null>(null);
  const [docs, setDocs] = useState<DocumentOut[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 350);
  const [health, setHealth] = useState<string>("");
  const [healthTotals, setHealthTotals] = useState<HealthTotals>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.collections.tree().then(setTree).catch(() => {});
  }, [collectionId]);

  const path = useMemo(() => (tree ? findPath(tree, collectionId) : null), [tree, collectionId]);
  const node = path ? path[path.length - 1] : null;

  async function loadMore() {
    if (loadingMore || docs === null || total === null || docs.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await api.collections.documents(collectionId, {
        search: debouncedSearch || undefined,
        sort: "name_asc",
        group,
        offset: docs.length,
        limit: PAGE_SIZE,
        health: health || undefined,
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
    if (!collectionId) return;
    setDocs(null);
    setTotal(null);
    setError(null);
    api.collections
      .documents(collectionId, {
        search: debouncedSearch || undefined,
        sort: "name_asc",
        group,
        offset: 0,
        limit: PAGE_SIZE,
        health: health || undefined,
      })
      .then((res) => {
        setDocs(res.documents);
        setTotal(res.total);
        setHealthTotals(res.healthTotals ?? {});
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "Failed to load channels");
        setDocs([]);
        setTotal(0);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, group, debouncedSearch, health]);

  useEffect(() => setHealth(""), [collectionId, group]);

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

  const groupLabel = group || "Other channels";

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: "Library", to: "/", icon: <Home size={14} /> },
          { label: byId(node.sourceType)?.name ?? node.sourceType, to: `/s/${node.sourceType}` },
          ...path!.map((p) => ({ label: p.name, to: `/c/${p.id}` })),
          { label: groupLabel },
        ]}
      />

      <div>
        <h1 className="text-2xl font-semibold">{groupLabel}</h1>
        <p className="text-panda-muted text-sm mt-1">
          In {node.name}
          {total !== null ? ` · ${total.toLocaleString()} channel${total === 1 ? "" : "s"}` : ""}
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter channels in this category…"
          className="flex-1 min-w-[200px] bg-panda-surface border border-panda-border rounded-lg px-3 py-2 text-sm outline-none focus:border-panda-accent"
        />
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
      </div>

      {docs === null && (
        <div className="flex items-center gap-2 text-panda-muted text-sm">
          <Loader2 className="animate-spin" size={16} /> Loading channels…
        </div>
      )}

      {docs && docs.length === 0 && (
        <EmptyState
          title="No channels found"
          hint="Nothing here yet, or your filter didn't match — every word has to appear in the channel name."
        />
      )}

      {docs && docs.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {docs.map((d) => (
              <ChannelTile key={`${d.sourceId}-${d.id}`} doc={d} />
            ))}
          </div>
          {total !== null && docs.length < total && (
            <div ref={sentinelRef} className="flex items-center justify-center gap-2 text-panda-muted text-sm py-4">
              <Loader2 className="animate-spin" size={16} /> Loading more…
            </div>
          )}
        </div>
      )}

      <BackToTop />
    </div>
  );
}
