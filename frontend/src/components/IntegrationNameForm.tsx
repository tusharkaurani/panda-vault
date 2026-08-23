import { FormEvent, useState } from "react";
import IntegrationIcon from "./IntegrationIcon";
import type { Integration } from "../types";

/** Names an integration's root node in the Library.
 *
 *  Used both when adding one and when renaming it later, because the question
 *  is the same either way — "what should this be called in the Library?" —
 *  and the answer is only ever one field. Blank resets to the catalog default
 *  rather than failing, so the field is always safe to clear. */
export default function IntegrationNameForm({
  integration,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  integration: Integration;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(integration.added ? integration.name : integration.defaultName);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(name.trim());
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-panda-border bg-panda-surface2 p-4"
    >
      <div className="flex items-center gap-2">
        <IntegrationIcon id={integration.id} className="text-panda-accent shrink-0" />
        <span className="text-sm font-medium">{integration.defaultName}</span>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-panda-muted">Name in the Library</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={integration.defaultName}
          maxLength={60}
          autoFocus
          className="bg-panda-surface border border-panda-border rounded-lg px-3 py-2 outline-none focus:border-panda-accent"
        />
        <span className="text-xs text-panda-muted">
          What this integration's root folder is called. Leave blank for "{integration.defaultName}" — you can
          change it any time.
        </span>
      </label>
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm rounded-lg border border-panda-border hover:border-panda-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-lg bg-panda-accent text-panda-bg font-medium hover:opacity-90 disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
