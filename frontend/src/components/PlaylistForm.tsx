import { FormEvent, useState } from "react";
import type { Playlist } from "../types";
import ExtensionPills from "./ExtensionPills";

export interface PlaylistFormValues {
  name: string;
  description: string;
  /** "" when the playlist is (or is becoming) upload-sourced. */
  url: string;
  allowedExtensions: string[];
  /** null = whatever the server's default is, rather than a copy of it, so
   *  changing that default moves every playlist that never had an opinion.
   *  Meaningless when `file` is set — an uploaded playlist has nothing to
   *  periodically re-fetch. */
  refreshMinutes: number | null;
  /** Present when adding via upload, or replacing an already-uploaded
   *  playlist's file. Absent for the URL flow. */
  file?: File;
}

/** A playlist is a full re-download every time, so these are deliberately
 *  coarse — the useful question is "how often does this provider actually
 *  change", not "how fresh can I make it". Anything daily or slower is run
 *  in the server's nightly window rather than on the exact hour. */
const INTERVALS: { label: string; value: number | null }[] = [
  { label: "Default (nightly)", value: null },
  { label: "Every 6 hours", value: 360 },
  { label: "Every 12 hours", value: 720 },
  { label: "Daily", value: 1440 },
  { label: "Every 3 days", value: 4320 },
  { label: "Weekly", value: 10080 },
];

export default function PlaylistForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
}: {
  initial?: Playlist;
  onSubmit: (values: PlaylistFormValues) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  // Fixed to whichever source the playlist already has when editing — only
  // the Add form lets the user pick, since switching an existing playlist
  // between a URL and an uploaded file would leave it in a confusing state.
  const isEditingUpload = initial?.source === "upload";
  const [mode, setMode] = useState<"url" | "upload">(isEditingUpload ? "upload" : "url");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [extensions, setExtensions] = useState<string[]>(initial?.allowedExtensions ?? []);
  const [refreshMinutes, setRefreshMinutes] = useState<number | null>(initial?.refreshMinutes ?? null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (mode === "url") {
      if (!url.trim()) return;
    } else if (!initial && !file) {
      // Adding via upload needs a file; replacing an already-uploaded
      // playlist's file is optional — leaving it out just updates the rest.
      return;
    }
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      url: mode === "url" ? url.trim() : "",
      allowedExtensions: extensions,
      refreshMinutes: mode === "url" ? refreshMinutes : null,
      file: file ?? undefined,
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-panda-border bg-panda-surface2 p-4">
      {!initial && (
        <div className="flex items-center gap-1 self-start rounded-lg border border-panda-border bg-panda-surface p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode("url")}
            className={`px-3 py-1 rounded-md ${
              mode === "url" ? "bg-panda-accent text-panda-bg font-medium" : "text-panda-muted hover:text-panda-text"
            }`}
          >
            From URL
          </button>
          <button
            type="button"
            onClick={() => setMode("upload")}
            className={`px-3 py-1 rounded-md ${
              mode === "upload" ? "bg-panda-accent text-panda-bg font-medium" : "text-panda-muted hover:text-panda-text"
            }`}
          >
            Upload file
          </button>
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-panda-muted">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Live TV"
            required
            className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
          />
        </label>
        {mode === "url" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-panda-muted">Playlist URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              type="url"
              placeholder="https://example.com/playlist.m3u"
              required
              className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent font-mono text-xs"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-panda-muted">{isEditingUpload ? "Replace file (optional)" : "Playlist file"}</span>
            <input
              type="file"
              accept=".m3u,.m3u8,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"
              required={!initial}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="bg-panda-surface border border-panda-border rounded-lg px-3 py-1.5 outline-none focus:border-panda-accent text-xs file:mr-3 file:rounded-md file:border-0 file:bg-panda-surface2 file:px-2 file:py-1 file:text-panda-text"
            />
            {isEditingUpload && !file && initial?.originalFilename && (
              <span className="text-xs text-panda-muted font-mono truncate">Current: {initial.originalFilename}</span>
            )}
          </label>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-panda-muted">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional notes about this playlist"
            className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
          />
        </label>
        {mode === "url" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-panda-muted">Re-fetch</span>
            <select
              value={refreshMinutes ?? ""}
              onChange={(e) => setRefreshMinutes(e.target.value ? Number(e.target.value) : null)}
              className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
            >
              {INTERVALS.map((i) => (
                <option key={i.label} value={i.value ?? ""}>
                  {i.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-panda-muted">
              Each re-fetch downloads the whole playlist, so pick the slowest that keeps up with
              the provider.
            </span>
          </label>
        ) : (
          <p className="text-xs text-panda-muted sm:self-end sm:pb-2">
            An uploaded playlist is parsed once — there's no periodic re-fetch. Come back here and
            upload a new file any time to update it.
          </p>
        )}
      </div>
      <ExtensionPills
        value={extensions}
        onChange={setExtensions}
        label="Allowed stream extensions (optional)"
        hint="Matched against the stream URL, not the channel name — e.g. m3u8 to hide direct .ts feeds. Leave empty to show everything."
        placeholder="m3u8, ts, …"
      />
      <div className="flex items-center gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded-lg border border-panda-border hover:border-panda-muted">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm rounded-lg bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {initial ? "Save changes" : "Add playlist"}
        </button>
      </div>
    </form>
  );
}
