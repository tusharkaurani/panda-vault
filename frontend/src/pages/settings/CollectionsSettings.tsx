import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, ApiError } from "../../api";
import type { Channel, Collection, Playlist, SourceType } from "../../types";
import CollectionTreeEditor, { CollectionCreateForm } from "../../components/CollectionTreeEditor";
import EmptyState from "../../components/EmptyState";
import ErrorBanner from "../../components/ErrorBanner";
import { useIntegrations } from "../../integrations/IntegrationsContext";

/** The Collections tab: one tree per integration, never shown mixed. Separate
 *  from Integrations because it applies to every source type at once — which
 *  is also why it, and not the registry beside it, carries the cost of
 *  loading every source. */
export default function CollectionsSettings() {
  const integrations = useIntegrations();
  // `?type=` so an integration's own page can deep-link straight at its tree.
  const [params, setParams] = useSearchParams();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingRootCollection, setAddingRootCollection] = useState(false);
  const [treeType, setTreeType] = useState<SourceType>((params.get("type") as SourceType) ?? "telegram");

  async function refresh() {
    // Channels 401 without a Telegram session, and that must not stop the
    // playlists and collections from loading — an M3U-only install lives
    // entirely in the other two.
    const [c, p, f] = await Promise.allSettled([
      api.channels.list(),
      api.playlists.list(),
      api.collections.tree(),
    ]);
    setChannels(c.status === "fulfilled" ? c.value : []);
    setPlaylists(p.status === "fulfilled" ? p.value : []);
    if (f.status === "fulfilled") {
      setCollections(f.value);
      setError(null);
    } else {
      setError(f.reason instanceof ApiError ? f.reason.message : "Failed to load settings data");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const sourcesForTree = treeType === "telegram" ? channels ?? [] : playlists ?? [];
  const treeNodes = useMemo(
    () => (collections ?? []).filter((n) => n.sourceType === treeType),
    [collections, treeType]
  );

  // `?type=` can name an integration this vault doesn't have (a stale link, or
  // one removed since); fall back to one the user actually has.
  useEffect(() => {
    if (integrations.added.length && !integrations.added.some((i) => i.id === treeType)) {
      setTreeType(integrations.added[0].id);
    }
  }, [integrations.added, treeType]);

  if (integrations.added.length === 0) {
    return (
      <EmptyState
        title="No integrations yet"
        hint="Collections organize an integration's sources, so add one first."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorBanner message={error} />}

      {/* One tree per integration, never shown mixed — the root holds them
          side by side and a collection can only bind its own type. */}
      <div className="flex gap-1 rounded-lg border border-panda-border bg-panda-surface2 p-1 self-start text-sm">
        {integrations.added.map((entry) => (
          <button
            key={entry.id}
            onClick={() => {
              setTreeType(entry.id);
              setParams({ type: entry.id }, { replace: true });
              setAddingRootCollection(false);
            }}
            className={`px-3 py-1 rounded-md transition-colors ${
              treeType === entry.id
                ? "bg-panda-accent text-panda-bg font-medium"
                : "text-panda-muted hover:text-panda-text"
            }`}
          >
            {entry.name}
          </button>
        ))}
      </div>

      <div className="flex justify-between items-center">
        <p className="text-sm text-panda-muted">
          Collections control what appears under {integrations.byId(treeType)?.name ?? treeType} in the Library.
        </p>
        <button
          onClick={() => setAddingRootCollection((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} /> Add root collection
        </button>
      </div>

      {addingRootCollection && (
        <CollectionCreateForm
          parentId={null}
          sourceType={treeType}
          sources={sourcesForTree}
          onDone={() => {
            setAddingRootCollection(false);
            refresh();
          }}
          onCancel={() => setAddingRootCollection(false)}
        />
      )}

      {collections && treeNodes.length === 0 && !addingRootCollection && (
        <EmptyState
          title={`No ${integrations.byId(treeType)?.name ?? treeType} collections yet`}
          hint={
            treeType === "telegram"
              ? "Create a root collection (e.g. 'Magazines'), then add sub-collections or bind it directly to a channel."
              : "Create a root collection (e.g. 'Live TV'), then add sub-collections or bind it directly to a playlist."
          }
        />
      )}

      {collections && treeNodes.length > 0 && (
        <CollectionTreeEditor
          nodes={treeNodes}
          allNodes={collections}
          sources={sourcesForTree}
          onChange={refresh}
        />
      )}
    </div>
  );
}
