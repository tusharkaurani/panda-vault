import { useEffect, useState } from "react";
import { ExternalLink, LogIn, Pencil, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api";
import type { Channel } from "../../types";
import { telegramUrl } from "../../lib/telegram";
import ChannelCollections from "../ChannelCollections";
import ChannelForm, { ChannelFormValues } from "../ChannelForm";
import CopyLinkButton from "../CopyLinkButton";
import EmptyState from "../EmptyState";
import FileCount from "../FileCount";
import ScanProgress from "../ScanProgress";
import StatusBadge from "../StatusBadge";
import Tooltip from "../Tooltip";
import Login from "../../pages/Login";
import { useNotifications } from "../../notifications/NotificationContext";
import type { IntegrationPanelProps } from "./panel";

/** Telegram's own settings page body: sign-in, then the channels this account
 *  pulls documents from. */
export default function TelegramPanel({ integration, sourceCollections, onChanged }: IntegrationPanelProps) {
  const { pushToast, jobsBySource, jobsCompleted } = useNotifications();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setChannels(await api.channels.list());
    } catch {
      // 401 without a session — the sign-in prompt above says why.
      setChannels([]);
    }
  }

  // On mount, and again whenever a scan/rebuild finishes: the counts and
  // statuses it just changed are only computed server-side.
  useEffect(() => {
    load();
  }, [jobsCompleted]);

  async function create(values: ChannelFormValues) {
    try {
      await api.channels.create(values);
      setAdding(false);
      load();
      onChanged();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to add channel", "error");
    }
  }

  async function update(id: string, values: ChannelFormValues) {
    try {
      await api.channels.update(id, values);
      setEditing(null);
      load();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to update channel", "error");
    }
  }

  async function remove(c: Channel) {
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
    load();
    onChanged();
  }

  async function checkJoin(c: Channel) {
    setBusyId(c.id);
    try {
      await api.channels.join(c.id);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Could not join/verify channel", "error");
    } finally {
      setBusyId(null);
      load();
    }
  }

  async function rebuild(c: Channel) {
    if (!confirm(`Rescan "${c.name}" from scratch?\n\nThis reads the channel's entire message history again and replaces the existing cache — normally not needed since refreshes are incremental, but useful if the cache looks stale or wrong.`)) {
      return;
    }
    setBusyId(c.id);
    try {
      await api.channels.rebuild(c.id);
      pushToast(`Rescan started for "${c.name}" — you'll get notified when it's done.`, "info");
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start rescan", "error");
    } finally {
      setBusyId(null);
      load();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!integration.configured && (
        <p className="text-xs text-panda-muted">
          Set <code className="font-mono">TG_API_ID</code> and <code className="font-mono">TG_API_HASH</code> in the
          environment and restart to enable Telegram. Get them from{" "}
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

      {integration.configured && !integration.connected && !connecting && (
        <button
          onClick={() => setConnecting(true)}
          className="self-start flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90"
        >
          <LogIn size={16} /> Connect Telegram
        </button>
      )}

      {connecting && !integration.connected && (
        <div className="rounded-lg border border-panda-border bg-panda-surface2 p-4">
          <Login
            embedded
            onSuccess={() => {
              setConnecting(false);
              onChanged();
              load();
            }}
          />
        </div>
      )}

      <div className="flex justify-between items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium">Channels</h2>
          <p className="text-sm text-panda-muted">
            {integration.connected
              ? `${channels?.length ?? 0} channel(s) configured`
              : "Connect Telegram above to add channels."}
          </p>
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          disabled={!integration.connected}
          className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          <Plus size={16} /> Add channel
        </button>
      </div>

      {adding && <ChannelForm onSubmit={create} onCancel={() => setAdding(false)} />}

      {channels && channels.length === 0 && !adding && integration.connected && (
        <EmptyState
          title="No channels configured"
          hint="Add a Telegram channel by name/username/ID to start pulling documents from it."
        />
      )}

      <div className="flex flex-col gap-2">
        {channels?.map((c) =>
          editing?.id === c.id ? (
            <ChannelForm
              key={c.id}
              initial={c}
              onSubmit={(values) => update(c.id, values)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-panda-border bg-panda-surface px-4 py-3 flex-wrap"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{c.name}</span>
                  <FileCount count={c.fileCount} />
                  <StatusBadge status={c.status} job={jobsBySource[c.id]} />
                </div>
                <p className="text-xs text-panda-muted font-mono">{c.channel}</p>
                {c.description && <p className="text-xs text-panda-muted mt-0.5">{c.description}</p>}
                {sourceCollections && <ChannelCollections collections={sourceCollections[c.id] ?? []} />}
                {jobsBySource[c.id] && <ScanProgress job={jobsBySource[c.id]} />}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!c.joined && (
                  <Tooltip label="Join / verify access">
                    <button
                      onClick={() => checkJoin(c)}
                      disabled={busyId === c.id}
                      className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                    >
                      {busyId === c.id ? <RefreshCw size={16} className="animate-spin" /> : <LogIn size={16} />}
                    </button>
                  </Tooltip>
                )}
                <Tooltip label={jobsBySource[c.id] ? "Rescan already running" : "Rescan this channel from scratch"}>
                  <button
                    onClick={() => rebuild(c)}
                    disabled={busyId === c.id || !!jobsBySource[c.id]}
                    className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                  >
                    {busyId === c.id || jobsBySource[c.id] ? (
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
                    onClick={() => setEditing(c)}
                    className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                  >
                    <Pencil size={16} />
                  </button>
                </Tooltip>
                <Tooltip label="Delete channel">
                  <button
                    onClick={() => remove(c)}
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
  );
}
