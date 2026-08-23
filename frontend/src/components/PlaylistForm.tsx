import { FormEvent, useState } from "react";
import type { Playlist } from "../types";
import ExtensionPills from "./ExtensionPills";

export interface PlaylistFormValues {
  name: string;
  description: string;
  url: string;
  allowedExtensions: string[];
}

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

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      url: url.trim(),
      allowedExtensions: extensions,
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
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-panda-muted">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional notes about this playlist"
          className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
        />
      </label>
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
