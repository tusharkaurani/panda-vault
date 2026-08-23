import { KeyboardEvent, useState } from "react";
import { X } from "lucide-react";
import Tooltip from "./Tooltip";

function normalizeExtension(raw: string): string {
  return raw.trim().replace(/^\./, "").toLowerCase();
}

/** The extension-allowlist editor, shared by the channel and playlist forms.
 *  Extracted from ChannelForm when playlists needed the identical control —
 *  they filter on the *stream URL's* extension rather than a filename's, but
 *  the editing affordance is the same. */
export default function ExtensionPills({
  value,
  onChange,
  label = "Allowed file extensions (optional)",
  hint = "Leave empty to show every file type.",
  placeholder = "pdf, jpg, …",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const ext = normalizeExtension(draft);
    if (!ext) return;
    if (!value.includes(ext)) onChange([...value, ext]);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Comma as well as Enter: users paste "pdf, epub" out of habit.
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    }
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-panda-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 bg-panda-surface border border-panda-border rounded-lg px-2 py-1.5 focus-within:border-panda-accent">
        {value.map((ext) => (
          <span
            key={ext}
            className="flex items-center gap-1 rounded-full bg-panda-surface2 border border-panda-border px-2 py-0.5 text-xs font-mono"
          >
            .{ext}
            <Tooltip label={`Remove .${ext}`}>
              <button
                type="button"
                onClick={() => onChange(value.filter((e) => e !== ext))}
                className="text-panda-muted hover:text-red-400"
              >
                <X size={12} />
              </button>
            </Tooltip>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          // Commit on blur too, so a typed-but-unconfirmed extension isn't
          // silently dropped when the user goes straight for Save.
          onBlur={commit}
          placeholder={value.length ? "" : placeholder}
          className="flex-1 min-w-[6rem] bg-transparent outline-none text-sm py-0.5"
        />
      </div>
      <span className="text-xs text-panda-muted">{hint}</span>
    </div>
  );
}
