import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Home,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api, ApiError } from "../api";
import type { Channel, Collection, Playlist, SourceType } from "../types";
import { telegramUrl } from "../lib/telegram";
import { collectionsBySource } from "../lib/collections";
import ChannelCollections from "../components/ChannelCollections";
import ChannelForm, { ChannelFormValues } from "../components/ChannelForm";
import PlaylistForm, { PlaylistFormValues } from "../components/PlaylistForm";
import CollectionTreeEditor, { CollectionCreateForm } from "../components/CollectionTreeEditor";
import CopyLinkButton from "../components/CopyLinkButton";
import FileCount from "../components/FileCount";
import ScanProgress from "../components/ScanProgress";
import StatusBadge from "../components/StatusBadge";
import Tooltip from "../components/Tooltip";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import IntegrationIcon from "../components/IntegrationIcon";
import Login from "./Login";
import { useIntegrations } from "../integrations/IntegrationsContext";
import { useNotifications } from "../notifications/NotificationContext";

// Two tabs, fixed. Integrations is the registry *and* where each added
// integration's sources are managed, inline — adding one grows that page
// rather than the tab strip, so the strip doesn't drift as source types are
// added. Collections is separate because it applies to every integration.
type Tab = "integrations" | "collections";

const TABS: { id: Tab; label: string }[] = [
  { id: "integrations", label: "Integrations" },
  { id: "collections", label: "Collections" },
];

export default function Settings() {
  const { pushToast, jobsBySource, jobsCompleted } = useNotifications();
  const integrations = useIntegrations();
  const [tab, setTab] = useState<Tab>("integrations");
  const [addingIntegration, setAddingIntegration] = useState(false);
  const [busyIntegration, setBusyIntegration] = useState<string | null>(null);
  // Collapsed panels, by integration id. Everything starts expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingChannel, setAddingChannel] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [addingPlaylist, setAddingPlaylist] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null);
  const [addingRootCollection, setAddingRootCollection] = useState(false);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Which integration's tree the Collections tab is editing. The root holds
  // one tree per integration and they are never shown mixed.
  const [treeType, setTreeType] = useState<SourceType>("telegram");

  // Reverse index of the collection tree, so each source card can show where
  // its contents surface in the library.
  const sourceCollections = useMemo(() => collectionsBySource(collections ?? []), [collections]);

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

  // Refetch on mount, and again whenever a scan/rebuild finishes — the
  // counts and statuses it just changed are only computed server-side.
  useEffect(() => {
    refresh();
  }, [jobsCompleted]);

  const sourcesForTree = treeType === "telegram" ? channels ?? [] : playlists ?? [];
  const treeNodes = (collections ?? []).filter((n) => n.sourceType === treeType);

  // Falls back to a not-added/not-configured shape so the Telegram tab can
  // render even in the instant before the catalog arrives.
  const telegram = integrations.byId("telegram") ?? {
    id: "telegram" as SourceType,
    name: "Telegram",
    description: "",
    needsCredentials: true,
    added: false,
    configured: false,
    connected: false,
    sourceCount: 0,
    needsSetup: false,
  };

  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // The collections tab edits one integration's tree; default it to one the
  // user actually has.
  useEffect(() => {
    if (integrations.added.length && !integrations.added.some((i) => i.id === treeType)) {
      setTreeType(integrations.added[0].id);
    }
  }, [integrations.added, treeType]);

  async function addIntegration(id: SourceType) {
    setBusyIntegration(id);
    try {
      await api.integrations.add(id);
      await integrations.refresh();
      setAddingIntegration(false);
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(id); // make sure the new panel is open
        return next;
      });
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to add integration", "error");
    } finally {
      setBusyIntegration(null);
    }
  }

  async function removeIntegration(id: SourceType, name: string) {
    if (!confirm(`Remove the ${name} integration?`)) return;
    setBusyIntegration(id);
    try {
      await api.integrations.remove(id);
      await integrations.refresh();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to remove integration", "error");
    } finally {
      setBusyIntegration(null);
    }
  }

  // ---------------------------------------------------------------- channels

  async function createChannel(values: ChannelFormValues) {
    try {
      await api.channels.create(values);
      setAddingChannel(false);
      refresh();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to add channel", "error");
    }
  }

  async function updateChannel(id: string, values: ChannelFormValues) {
    try {
      await api.channels.update(id, values);
      setEditingChannel(null);
      refresh();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to update channel", "error");
    }
  }

  async function deleteChannel(c: Channel) {
    if (!confirm(`Remove channel "${c.name}"?`)) return;
    try {
      await api.channels.remove(c.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (confirm(`${e.message}\n\nUnlink it from those collections and delete anyway?`)) {
          try {
            await api.channels.remove(c.id, true);
          } catch (e2) {
            pushToast(e2 instanceof ApiError ? e2.message : "Failed to delete channel", "error");
          }
        } else {
          return;
        }
      } else {
        pushToast(e instanceof ApiError ? e.message : "Failed to delete channel", "error");
        return;
      }
    }
    refresh();
  }

  async function checkJoin(c: Channel) {
    setBusySourceId(c.id);
    try {
      await api.channels.join(c.id);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Could not join/verify channel", "error");
    } finally {
      setBusySourceId(null);
      refresh();
    }
  }

  async function rebuildChannel(c: Channel) {
    if (!confirm(`Rescan "${c.name}" from scratch?\n\nThis reads the channel's entire message history again and replaces the existing cache — normally not needed since refreshes are incremental, but useful if the cache looks stale or wrong.`)) {
      return;
    }
    setBusySourceId(c.id);
    try {
      await api.channels.rebuild(c.id);
      pushToast(`Rescan started for "${c.name}" — you'll get notified when it's done.`, "info");
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start rescan", "error");
    } finally {
      setBusySourceId(null);
      refresh();
    }
  }

  // --------------------------------------------------------------- playlists

  async function createPlaylist(values: PlaylistFormValues) {
    try {
      await api.playlists.create(values);
      setAddingPlaylist(false);
      pushToast(`Fetching "${values.name}" — you'll get notified when it's scanned.`, "info");
      refresh();
      integrations.refresh(); // the first playlist makes M3U appear in the Library
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to add playlist", "error");
    }
  }

  async function updatePlaylist(id: string, values: PlaylistFormValues) {
    try {
      await api.playlists.update(id, values);
      setEditingPlaylist(null);
      refresh();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to update playlist", "error");
    }
  }

  async function deletePlaylist(p: Playlist) {
    if (!confirm(`Remove playlist "${p.name}"?`)) return;
    try {
      await api.playlists.remove(p.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (confirm(`${e.message}\n\nUnlink it from those collections and delete anyway?`)) {
          try {
            await api.playlists.remove(p.id, true);
          } catch (e2) {
            pushToast(e2 instanceof ApiError ? e2.message : "Failed to delete playlist", "error");
          }
        } else {
          return;
        }
      } else {
        pushToast(e instanceof ApiError ? e.message : "Failed to delete playlist", "error");
        return;
      }
    }
    refresh();
    integrations.refresh();
  }

  async function rescanPlaylist(p: Playlist) {
    setBusySourceId(p.id);
    try {
      await api.playlists.rescan(p.id);
      pushToast(`Re-fetching "${p.name}" — you'll get notified when it's done.`, "info");
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start rescan", "error");
    } finally {
      setBusySourceId(null);
      refresh();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-1 text-sm text-panda-muted flex-wrap">
        <Link to="/" className="flex items-center gap-1 hover:text-panda-accent">
          <Home size={14} /> Library
        </Link>
        <span className="flex items-center gap-1">
          <ChevronRight size={14} />
          <span className="text-panda-text font-medium">Settings</span>
        </span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-panda-muted text-sm mt-1">
          Connect an integration, manage the sources it provides, and organize them into collections.
        </p>
      </div>

      <div className="flex gap-1 border-b border-panda-border overflow-x-auto">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === id ? "border-panda-accent text-panda-text" : "border-transparent text-panda-muted hover:text-panda-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} />}

      {/* ------------------------------------------------------ integrations */}
      {tab === "integrations" && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <p className="text-sm text-panda-muted">
              Everything this vault is connected to. Each one gets its own tree in the Library.
            </p>
            <button
              onClick={() => setAddingIntegration((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90"
            >
              <Plus size={16} /> Add integration
            </button>
          </div>

          {/* The whole catalog, with the already-added ones disabled — so it's
              visible what else this build can connect, not just what's left. */}
          {addingIntegration && (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-panda-accent/50 bg-panda-surface2 p-3">
              {integrations.catalog.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => addIntegration(entry.id)}
                  disabled={entry.added || busyIntegration === entry.id}
                  className="flex items-start gap-3 rounded-lg border border-panda-border bg-panda-surface p-3 text-left transition-colors enabled:hover:border-panda-accent disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <IntegrationIcon id={entry.id} className="text-panda-accent shrink-0 mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{entry.name}</span>
                      {entry.added && <span className="text-xs text-panda-muted">Already added</span>}
                    </span>
                    <span className="block text-xs text-panda-muted mt-0.5">{entry.description}</span>
                  </span>
                </button>
              ))}
              {integrations.catalog.every((e) => e.added) && (
                <p className="text-xs text-panda-muted px-1">
                  Every integration this build supports is already added.
                </p>
              )}
            </div>
          )}

          {!integrations.loading && integrations.added.length === 0 && !addingIntegration && (
            <EmptyState
              title="No integrations yet"
              hint="Add one to start filling your vault. M3U needs no account; Telegram needs a one-time sign-in."
            />
          )}

          {/* One panel per added integration, holding that integration's own
              sources. Collapsible because an account with a dozen channels
              would otherwise bury every integration below it. */}
          {integrations.added.map((entry) => {
            const open = !collapsed.has(entry.id);
            return (
              <section key={entry.id} className="rounded-lg border border-panda-border bg-panda-surface">
                <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
                  <button
                    onClick={() => toggleCollapsed(entry.id)}
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${entry.name}`}
                    className="text-panda-muted hover:text-panda-text shrink-0"
                  >
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <IntegrationIcon id={entry.id} className="text-panda-accent shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{entry.name}</span>
                      {entry.needsSetup ? (
                        <span className="flex items-center gap-1 text-xs text-amber-400">
                          <TriangleAlert size={12} /> {entry.configured ? "Not signed in" : "Not configured"}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <Check size={12} /> Ready
                        </span>
                      )}
                      <span className="text-xs text-panda-muted">
                        {entry.sourceCount.toLocaleString()} source{entry.sourceCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  <Tooltip label={`Remove the ${entry.name} integration`}>
                    <button
                      onClick={() => removeIntegration(entry.id, entry.name)}
                      disabled={busyIntegration === entry.id}
                      className="p-1.5 rounded-md text-panda-muted hover:text-red-400 hover:bg-panda-surface2 disabled:opacity-50 shrink-0"
                    >
                      <Trash2 size={16} />
                    </button>
                  </Tooltip>
                </div>

                {open && (
                  <div className="flex flex-col gap-4 border-t border-panda-border px-4 py-4">
                    {entry.id === "telegram" && (
                      <>
                        {!telegram.configured && (
                          <p className="text-xs text-panda-muted">
                            Set <code className="font-mono">TG_API_ID</code> and{" "}
                            <code className="font-mono">TG_API_HASH</code> in the environment and restart to
                            enable Telegram. Get them from{" "}
                            <a
                              href="https://my.telegram.org/apps"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-panda-accent hover:underline"
                            >
                              my.telegram.org/apps
                            </a>
                            . Everything else in Panda Vault works without it.
                          </p>
                        )}

                        {telegram.configured && !telegram.connected && !connecting && (
                          <button
                            onClick={() => setConnecting(true)}
                            className="self-start flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90"
                          >
                            <LogIn size={16} /> Connect Telegram
                          </button>
                        )}

                        {connecting && !telegram.connected && (
                          <div className="rounded-lg border border-panda-border bg-panda-surface2 p-4">
                            <Login
                              embedded
                              onSuccess={() => {
                                setConnecting(false);
                                integrations.refresh();
                                refresh();
                              }}
                            />
                          </div>
                        )}

                        <h2 className="text-sm font-medium">Channels</h2>
                        <div className="flex justify-between items-center">
                          <p className="text-sm text-panda-muted">
                            {telegram.connected
                              ? `${channels?.length ?? 0} channel(s) configured`
                              : "Connect Telegram above to add channels."}
                          </p>
                          <button
                            onClick={() => setAddingChannel((v) => !v)}
                            disabled={!telegram.connected}
                            className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
                          >
                            <Plus size={16} /> Add channel
                          </button>
                        </div>

                        {addingChannel && <ChannelForm onSubmit={createChannel} onCancel={() => setAddingChannel(false)} />}

                        {channels && channels.length === 0 && !addingChannel && telegram.connected && (
                          <EmptyState title="No channels configured" hint="Add a Telegram channel by name/username/ID to start pulling documents from it." />
                        )}

                        <div className="flex flex-col gap-2">
                          {channels?.map((c) =>
                            editingChannel?.id === c.id ? (
                              <ChannelForm
                                key={c.id}
                                initial={c}
                                onSubmit={(values) => updateChannel(c.id, values)}
                                onCancel={() => setEditingChannel(null)}
                              />
                            ) : (
                              <div key={c.id} className="flex items-center gap-3 rounded-lg border border-panda-border bg-panda-surface px-4 py-3 flex-wrap">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-medium">{c.name}</span>
                                    <FileCount count={c.fileCount} />
                                    <StatusBadge status={c.status} job={jobsBySource[c.id]} />
                                  </div>
                                  <p className="text-xs text-panda-muted font-mono">{c.channel}</p>
                                  {c.description && <p className="text-xs text-panda-muted mt-0.5">{c.description}</p>}
                                  {collections && <ChannelCollections collections={sourceCollections[c.id] ?? []} />}
                                  {jobsBySource[c.id] && <ScanProgress job={jobsBySource[c.id]} />}
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {!c.joined && (
                                    <Tooltip label="Join / verify access">
                                      <button
                                        onClick={() => checkJoin(c)}
                                        disabled={busySourceId === c.id}
                                        className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                                      >
                                        {busySourceId === c.id ? <RefreshCw size={16} className="animate-spin" /> : <LogIn size={16} />}
                                      </button>
                                    </Tooltip>
                                  )}
                                  <Tooltip label={jobsBySource[c.id] ? "Rescan already running" : "Rescan this channel from scratch"}>
                                    <button
                                      onClick={() => rebuildChannel(c)}
                                      disabled={busySourceId === c.id || !!jobsBySource[c.id]}
                                      className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                                    >
                                      {busySourceId === c.id || jobsBySource[c.id] ? (
                                        <RefreshCw size={16} className="animate-spin" />
                                      ) : (
                                        <RotateCw size={16} />
                                      )}
                                    </button>
                                  </Tooltip>
                                  <CopyLinkButton
                                    url={telegramUrl(c.channel)}
                                    size={16}
                                    className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                                  />
                                  <Tooltip label={`Open ${c.channel} on Telegram`}>
                                    <a
                                      href={telegramUrl(c.channel)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                                    >
                                      <ExternalLink size={16} />
                                    </a>
                                  </Tooltip>
                                  <Tooltip label="Edit channel">
                                    <button
                                      onClick={() => setEditingChannel(c)}
                                      className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                                    >
                                      <Pencil size={16} />
                                    </button>
                                  </Tooltip>
                                  <Tooltip label="Delete channel">
                                    <button
                                      onClick={() => deleteChannel(c)}
                                      className="p-1.5 rounded-md text-panda-muted hover:text-red-400 hover:bg-panda-surface2"
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  </Tooltip>
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      </>
                    )}
                    {entry.id === "m3u" && (
                      <>
                        <p className="text-xs text-panda-muted">
                          Nothing to connect — add a playlist URL below and its entries are fetched straight away.
                        </p>

                        <h2 className="text-sm font-medium">Playlists</h2>
                        <div className="flex justify-between items-center">
                          <p className="text-sm text-panda-muted">{playlists?.length ?? 0} playlist(s) configured</p>
                          <button
                            onClick={() => setAddingPlaylist((v) => !v)}
                            className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90"
                          >
                            <Plus size={16} /> Add playlist
                          </button>
                        </div>

                        {addingPlaylist && <PlaylistForm onSubmit={createPlaylist} onCancel={() => setAddingPlaylist(false)} />}

                        {playlists && playlists.length === 0 && !addingPlaylist && (
                          <EmptyState
                            title="No playlists yet"
                            hint="Paste an M3U playlist URL — it's fetched and indexed straight away, no account needed."
                          />
                        )}

                        <div className="flex flex-col gap-2">
                          {playlists?.map((p) =>
                            editingPlaylist?.id === p.id ? (
                              <PlaylistForm
                                key={p.id}
                                initial={p}
                                onSubmit={(values) => updatePlaylist(p.id, values)}
                                onCancel={() => setEditingPlaylist(null)}
                              />
                            ) : (
                              <div key={p.id} className="flex items-center gap-3 rounded-lg border border-panda-border bg-panda-surface px-4 py-3 flex-wrap">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-medium">{p.name}</span>
                                    <FileCount count={p.fileCount} />
                                    <StatusBadge status={p.status} job={jobsBySource[p.id]} sourceType="m3u" />
                                  </div>
                                  <p className="text-xs text-panda-muted font-mono truncate">{p.url}</p>
                                  {p.description && <p className="text-xs text-panda-muted mt-0.5">{p.description}</p>}
                                  {collections && <ChannelCollections collections={sourceCollections[p.id] ?? []} />}
                                  {jobsBySource[p.id] && <ScanProgress job={jobsBySource[p.id]} />}
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Tooltip label={jobsBySource[p.id] ? "Re-fetch already running" : "Re-fetch this playlist now"}>
                                    <button
                                      onClick={() => rescanPlaylist(p)}
                                      disabled={busySourceId === p.id || !!jobsBySource[p.id]}
                                      className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                                    >
                                      {busySourceId === p.id || jobsBySource[p.id] ? (
                                        <RefreshCw size={16} className="animate-spin" />
                                      ) : (
                                        <RotateCw size={16} />
                                      )}
                                    </button>
                                  </Tooltip>
                                  <CopyLinkButton
                                    url={p.url}
                                    label="Copy playlist URL"
                                    size={16}
                                    className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                                  />
                                  <Tooltip label="Open the playlist file">
                                    <a
                                      href={p.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                                    >
                                      <ExternalLink size={16} />
                                    </a>
                                  </Tooltip>
                                  <Tooltip label="Edit playlist">
                                    <button
                                      onClick={() => setEditingPlaylist(p)}
                                      className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                                    >
                                      <Pencil size={16} />
                                    </button>
                                  </Tooltip>
                                  <Tooltip label="Delete playlist">
                                    <button
                                      onClick={() => deletePlaylist(p)}
                                      className="p-1.5 rounded-md text-panda-muted hover:text-red-400 hover:bg-panda-surface2"
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  </Tooltip>
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}


      {/* ------------------------------------------------------- collections */}
      {tab === "collections" && collections && integrations.added.length === 0 && (
        <EmptyState
          title="No integrations yet"
          hint="Collections organize an integration's sources, so add one first."
        />
      )}

      {tab === "collections" && collections && integrations.added.length > 0 && (
        <div className="flex flex-col gap-4">
          {/* One tree per integration, never shown mixed — the root holds them
              side by side and a collection can only bind its own type. */}
          <div className="flex gap-1 rounded-lg border border-panda-border bg-panda-surface2 p-1 self-start text-sm">
            {integrations.added.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  setTreeType(entry.id);
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

          {treeNodes.length === 0 && !addingRootCollection && (
            <EmptyState
              title={`No ${integrations.byId(treeType)?.name ?? treeType} collections yet`}
              hint={
                treeType === "telegram"
                  ? "Create a root collection (e.g. 'Magazines'), then add sub-collections or bind it directly to a channel."
                  : "Create a root collection (e.g. 'Live TV'), then add sub-collections or bind it directly to a playlist."
              }
            />
          )}

          {treeNodes.length > 0 && (
            <CollectionTreeEditor
              nodes={treeNodes}
              allNodes={collections}
              sources={sourcesForTree}
              onChange={refresh}
            />
          )}
        </div>
      )}
    </div>
  );
}
