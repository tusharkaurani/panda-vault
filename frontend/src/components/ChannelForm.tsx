import { FormEvent, KeyboardEvent, useState } from "react";
import { X } from "lucide-react";
import type { Channel } from "../types";

export interface ChannelFormValues {
  name: string;
  description: string;
  channel: string;
  allowedExtensions: string[];
}

function normalizeExtension(raw: string): string {
  return raw.trim().replace(/^\./, "").toLowerCase();
}

export default function ChannelForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
}: {
  initial?: Channel;
  onSubmit: (values: ChannelFormValues) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [channel, setChannel] = useState(initial?.channel ?? "");
  const [extensions, setExtensions] = useState<string[]>(initial?.allowedExtensions ?? []);
  const [extensionInput, setExtensionInput] = useState("");

  function addExtension() {
    const ext = normalizeExtension(extensionInput);
    if (!ext) return;
    setExtensions((prev) => (prev.includes(ext) ? prev : [...prev, ext]));
    setExtensionInput("");
  }

  function removeExtension(ext: string) {
    setExtensions((prev) => prev.filter((e) => e !== ext));
  }

  function onExtensionInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addExtension();
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !channel.trim()) return;
    onSubmit({ name: name.trim(), description: description.trim(), channel: channel.trim(), allowedExtensions: extensions });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-panda-border bg-panda-surface2 p-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-panda-muted">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Economic Times"
            required
            className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-panda-muted">Channel ID / username / invite link</span>
          <input
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="@channelname, -100123456789, or t.me/joinchat/…"
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
          placeholder="Optional notes about this channel"
          className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
        />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-panda-muted">Allowed file extensions (optional)</span>
        <div className="flex flex-wrap items-center gap-1.5 bg-panda-surface border border-panda-border rounded-lg px-2 py-1.5 focus-within:border-panda-accent">
          {extensions.map((ext) => (
            <span
              key={ext}
              className="flex items-center gap-1 rounded-full bg-panda-surface2 border border-panda-border px-2 py-0.5 text-xs font-mono"
            >
              .{ext}
              <button
                type="button"
                onClick={() => removeExtension(ext)}
                className="text-panda-muted hover:text-red-400"
                title={`Remove .${ext}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            value={extensionInput}
            onChange={(e) => setExtensionInput(e.target.value)}
            onKeyDown={onExtensionInputKeyDown}
            onBlur={addExtension}
            placeholder={extensions.length ? "" : "pdf, jpg, …"}
            className="flex-1 min-w-[6rem] bg-transparent outline-none text-sm py-0.5"
          />
        </div>
        <span className="text-xs text-panda-muted">Leave empty to show every file type.</span>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded-lg border border-panda-border hover:border-panda-muted">
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm rounded-lg bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {initial ? "Save changes" : "Add channel"}
        </button>
      </div>
    </form>
  );
}
