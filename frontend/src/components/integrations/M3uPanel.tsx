import { useEffect, useState } from "react";
import { Activity, Download, ExternalLink, Pencil, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api";
import type { Playlist } from "../../types";
import ChannelCollections from "../ChannelCollections";
import CopyLinkButton from "../CopyLinkButton";
import EmptyState from "../EmptyState";
import FileCount from "../FileCount";
import PlaylistForm, { PlaylistFormValues } from "../PlaylistForm";
import PlaylistHealthNote from "../PlaylistHealthNote";
import StreamCheckPanel from "./StreamCheckPanel";
import ScanProgress from "../ScanProgress";
import StatusBadge from "../StatusBadge";
import Tooltip from "../Tooltip";
import { useNotifications } from "../../notifications/NotificationContext";
import type { IntegrationPanelProps } from "./panel";

/** M3U's own settings page body. There is no account to connect — a playlist
 *  URL is the whole configuration. */
export default function M3uPanel({ sourceCollections, onChanged }: IntegrationPanelProps) {
  const { pushToast, jobsBySource, jobsCompleted } = useNotifications();
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Playlist | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setPlaylists(await api.playlists.list());
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to load playlists", "error");
      setPlaylists([]);
    }
  }

  useEffect(() => {
    load();
  }, [jobsCompleted]);

  async function create(values: PlaylistFormValues) {
    try {
      if (values.file) {
        await api.playlists.createFromUpload({
          name: values.name,
          description: values.description,
          allowedExtensions: values.allowedExtensions,
          file: values.file,
        });
      } else {
        await api.playlists.create(values);
      }
      setAdding(false);
      pushToast(`Parsing "${values.name}" — you'll get notified when it's scanned.`, "info");
      load();
      onChanged();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to add playlist", "error");
    }
  }

  async function update(p: Playlist, values: PlaylistFormValues) {
    try {
      await api.playlists.update(p.id, {
        name: values.name,
        description: values.description,
        ...(p.source === "upload" ? {} : { url: values.url, refreshMinutes: values.refreshMinutes }),
        allowedExtensions: values.allowedExtensions,
      });
      if (values.file) {
        await api.playlists.replaceUpload(p.id, values.file);
        pushToast(`Replacing "${values.name}"'s file — you'll get notified when it's done.`, "info");
      }
      setEditing(null);
      load();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to update playlist", "error");
    }
  }

  async function remove(p: Playlist) {
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
    load();
    onChanged();
  }

  /** `force` is the user accepting a snapshot the server refused for being
   *  drastically smaller than the one it would replace. Confirmed here
   *  rather than server-side, because the numbers are what make it a
   *  decision and they're already on screen. */
  async function rescan(p: Playlist, force = false) {
    if (force && !confirm(
      `"${p.name}" came back much smaller than the copy you have.\n\n` +
      `Replacing it will drop the entries the provider no longer lists, and ` +
      `the only way to get them back is if the provider starts serving them again.\n\nReplace anyway?`
    )) return;
    setBusyId(p.id);
    try {
      await api.playlists.rescan(p.id, force);
      pushToast(`Re-fetching "${p.name}" — you'll get notified when it's done.`, "info");
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start rescan", "error");
    } finally {
      setBusyId(null);
      load();
    }
  }

  async function checkStreams(p: Playlist) {
    try {
      await api.playlists.checkStreams(p.id);
      pushToast(`Checking streams for "${p.name}" — you'll get notified when it's done.`, "info");
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start the check", "error");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-panda-muted">
        Nothing to connect — add a playlist by URL or upload an .m3u file below, and its channels
        are indexed straight away.
      </p>

      <div className="flex justify-between items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium">Playlists</h2>
          <p className="text-sm text-panda-muted">{playlists?.length ?? 0} playlist(s) configured</p>
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90"
        >
          <Plus size={16} /> Add playlist
        </button>
      </div>

      {adding && <PlaylistForm onSubmit={create} onCancel={() => setAdding(false)} />}

      <StreamCheckPanel onChanged={onChanged} />

      {playlists && playlists.length === 0 && !adding && (
        <EmptyState
          title="No playlists yet"
          hint="Paste an M3U playlist URL, or upload a file — either way it's indexed straight away, no account needed."
        />
      )}

      <div className="flex flex-col gap-2">
        {playlists?.map((p) =>
          editing?.id === p.id ? (
            <PlaylistForm
              key={p.id}
              initial={p}
              onSubmit={(values) => update(p, values)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-lg border border-panda-border bg-panda-surface px-4 py-3 flex-wrap"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{p.name}</span>
                  <FileCount count={p.fileCount} />
                  <StatusBadge status={p.status} job={jobsBySource[p.id]} sourceType="m3u" />
                </div>
                <p className="text-xs text-panda-muted font-mono truncate">
                  {p.source === "upload" ? `Uploaded file — ${p.originalFilename ?? "no periodic re-fetch"}` : p.url}
                </p>
                {p.description && <p className="text-xs text-panda-muted mt-0.5">{p.description}</p>}
                <PlaylistHealthNote
                  playlist={p}
                  job={jobsBySource[p.id]}
                  busy={busyId === p.id}
                  onReplaceAnyway={() => rescan(p, true)}
                />
                {sourceCollections && <ChannelCollections collections={sourceCollections[p.id] ?? []} />}
                {jobsBySource[p.id] &&
                  (jobsBySource[p.id].status === "queued" ? (
                    <p className="mt-1.5 text-[11px] text-panda-muted">Queued — waiting for the current check to finish</p>
                  ) : (
                    <ScanProgress
                      job={jobsBySource[p.id]}
                      unit={jobsBySource[p.id].kind === "health" ? "streams" : "files"}
                    />
                  ))}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Tooltip
                  label={
                    jobsBySource[p.id]?.kind === "health"
                      ? jobsBySource[p.id].status === "queued"
                        ? "Stream check queued"
                        : "Checking streams now"
                      : "Check this playlist's streams now"
                  }
                >
                  <button
                    onClick={() => checkStreams(p)}
                    disabled={!!jobsBySource[p.id]}
                    className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                  >
                    <Activity size={16} className={jobsBySource[p.id]?.kind === "health" ? "animate-pulse" : ""} />
                  </button>
                </Tooltip>
                {p.source === "url" && (
                  <Tooltip label={jobsBySource[p.id] ? "Re-fetch already running" : "Re-fetch this playlist now"}>
                    <button
                      onClick={() => rescan(p)}
                      disabled={busyId === p.id || !!jobsBySource[p.id]}
                      className="flex items-center gap-1 p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
                    >
                      {busyId === p.id || jobsBySource[p.id] ? (
                        <RefreshCw size={16} className="animate-spin" />
                      ) : (
                        <RotateCw size={16} />
                      )}
                    </button>
                  </Tooltip>
                )}
                {p.source === "url" && (
                  <>
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
                  </>
                )}
                <Tooltip label="Edit playlist">
                  <button
                    onClick={() => setEditing(p)}
                    className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                  >
                    <Pencil size={16} />
                  </button>
                </Tooltip>
                <Tooltip label="Download m3u file">
                  <a
                    href={`/api/playlists/${p.id}/download`}
                    download
                    className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
                  >
                    <Download size={16} />
                  </a>
                </Tooltip>
                <Tooltip label="Delete playlist">
                  <button
                    onClick={() => remove(p)}
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
