import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, ExternalLink, Home, Plus, RefreshCw, Pencil, Trash2, LogIn, RotateCw } from "lucide-react";
import { api, ApiError } from "../api";
import type { Channel, Collection } from "../types";
import { telegramUrl } from "../lib/telegram";
import { collectionsByChannel } from "../lib/collections";
import ChannelCollections from "../components/ChannelCollections";
import ChannelForm, { ChannelFormValues } from "../components/ChannelForm";
import CollectionTreeEditor, { CollectionCreateForm } from "../components/CollectionTreeEditor";
import CopyLinkButton from "../components/CopyLinkButton";
import FileCount from "../components/FileCount";
import ScanProgress from "../components/ScanProgress";
import StatusBadge from "../components/StatusBadge";
import Tooltip from "../components/Tooltip";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import { useNotifications } from "../notifications/NotificationContext";

type Tab = "channels" | "collections";

export default function Settings() {
  const { pushToast, jobsByChannel, jobsCompleted } = useNotifications();
  const [tab, setTab] = useState<Tab>("channels");
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingChannel, setAddingChannel] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [addingRootCollection, setAddingRootCollection] = useState(false);
  const [busyChannelId, setBusyChannelId] = useState<string | null>(null);

  // Reverse index of the collection tree, so each channel card can show
  // where its documents surface in the library.
  const channelCollections = useMemo(() => collectionsByChannel(collections ?? []), [collections]);

  async function refresh() {
    try {
      const [c, f] = await Promise.all([api.channels.list(), api.collections.tree()]);
      setChannels(c);
      setCollections(f);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load settings data");
    }
  }

  // Refetch on mount, and again whenever a scan/rebuild finishes — the
  // counts and statuses it just changed are only computed server-side.
  useEffect(() => {
    refresh();
  }, [jobsCompleted]);

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
    setBusyChannelId(c.id);
    try {
      await api.channels.join(c.id);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Could not join/verify channel", "error");
    } finally {
      setBusyChannelId(null);
      refresh();
    }
  }

  async function rebuildChannel(c: Channel) {
    if (!confirm(`Rescan "${c.name}" from scratch?\n\nThis reads the channel's entire message history again and replaces the existing cache — normally not needed since refreshes are incremental, but useful if the cache looks stale or wrong.`)) {
      return;
    }
    setBusyChannelId(c.id);
    try {
      await api.channels.rebuild(c.id);
      pushToast(`Rescan started for "${c.name}" — you'll get notified when it's done.`, "info");
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start rescan", "error");
    } finally {
      setBusyChannelId(null);
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
        <p className="text-panda-muted text-sm mt-1">Manage Telegram channels and the collection structure shown on the landing page.</p>
      </div>

      <div className="flex gap-1 border-b border-panda-border">
        {(["channels", "collections"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
              tab === t ? "border-panda-accent text-panda-text" : "border-transparent text-panda-muted hover:text-panda-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} />}

      {tab === "channels" && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-panda-muted">{channels?.length ?? 0} channel(s) configured</p>
            <button
              onClick={() => setAddingChannel((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90"
            >
              <Plus size={16} /> Add channel
            </button>
          </div>

          {addingChannel && <ChannelForm onSubmit={createChannel} onCancel={() => setAddingChannel(false)} />}

          {channels && channels.length === 0 && !addingChannel && (
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
                      <StatusBadge status={c.status} job={jobsByChannel[c.id]} />
                    </div>
                    <p className="text-xs text-panda-muted font-mono">{c.channel}</p>
                    {c.description && <p className="text-xs text-panda-muted mt-0.5">{c.description}</p>}
                    {collections && <ChannelCollections collections={channelCollections[c.id] ?? []} />}
                    {jobsByChannel[c.id] && <ScanProgress job={jobsByChannel[c.id]} />}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!c.joined && (
                      <Tooltip label="Join / verify access">
                        <button
                          onClick={() => checkJoin(c)}
                          disabled={busyChannelId === c.id}
                          className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                        >
                          {busyChannelId === c.id ? <RefreshCw size={16} className="animate-spin" /> : <LogIn size={16} />}
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip label={jobsByChannel[c.id] ? "Rescan already running" : "Rescan this channel from scratch"}>
                      <button
                        onClick={() => rebuildChannel(c)}
                        disabled={busyChannelId === c.id || !!jobsByChannel[c.id]}
                        className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                      >
                        {busyChannelId === c.id || jobsByChannel[c.id] ? (
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
        </div>
      )}

      {tab === "collections" && channels && collections && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-panda-muted">Collections control what appears on the landing page.</p>
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
              channels={channels}
              onDone={() => {
                setAddingRootCollection(false);
                refresh();
              }}
              onCancel={() => setAddingRootCollection(false)}
            />
          )}

          {collections.length === 0 && !addingRootCollection && (
            <EmptyState title="No collections yet" hint="Create a root collection (e.g. 'Magazines'), then add sub-collections or bind it directly to a channel." />
          )}

          {collections.length > 0 && <CollectionTreeEditor nodes={collections} allNodes={collections} channels={channels} onChange={refresh} />}
        </div>
      )}
    </div>
  );
}
