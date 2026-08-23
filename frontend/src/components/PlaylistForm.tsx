import { FormEvent, useState } from "react";
import type { Playlist } from "../types";
import ExtensionPills from "./ExtensionPills";

export interface PlaylistFormValues {
  name: string;
  description: string;
  url: string;
  allowedExtensions: string[];
  /** null = whatever the server's default is, rather than a copy of it, so
   *  changing that default moves every playlist that never had an opinion. */
  refreshMinutes: number | null;
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
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [extensions, setExtensions] = useState<string[]>(initial?.allowedExtensions ?? []);
  const [refreshMinutes, setRefreshMinutes] = useState<number | null>(initial?.refreshMinutes ?? null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      url: url.trim(),
      allowedExtensions: extensions,
      refreshMinutes,
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-panda-border bg-panda-surface2 p-4">
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
