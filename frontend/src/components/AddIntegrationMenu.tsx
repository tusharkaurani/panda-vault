import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import IntegrationIcon from "./IntegrationIcon";
import type { Integration, SourceType } from "../types";

/** The "Add integration" control: a button that drops the whole catalog as a
 *  menu, rather than expanding a block of cards into the page. The catalog is
 *  short and picking from it is a one-off action, so it doesn't deserve
 *  permanent space above the list of integrations you actually use. */
export default function AddIntegrationMenu({
  catalog,
  busyId,
  onAdd,
}: {
  catalog: Integration[];
  /** Id currently being added, so its row can show as pending. */
  busyId: string | null;
  onAdd: (id: SourceType) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. Bound only while open so the app
  // isn't carrying two document listeners for a menu nobody opened.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busyId !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg bg-panda-accent text-panda-bg px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        <Plus size={16} /> Add integration
        <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-panda-border bg-panda-surface shadow-lg"
        >
          {/* The whole catalog, with the added ones disabled rather than
              filtered out — it should be visible what else this build can
              connect, not just what's left. */}
          {catalog.map((entry) => (
            <button
              key={entry.id}
              role="menuitem"
              onClick={() => {
                onAdd(entry.id);
                setOpen(false);
              }}
              disabled={entry.added || busyId === entry.id}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left enabled:hover:bg-panda-surface2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <IntegrationIcon id={entry.id} className="text-panda-accent shrink-0 mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{entry.name}</span>
                  {entry.added && <span className="text-xs text-panda-muted">Already added</span>}
                </span>
                <span className="block text-xs text-panda-muted mt-0.5">{entry.description}</span>
              </span>
            </button>
          ))}
          {catalog.length === 0 && (
            <p className="px-3 py-2.5 text-xs text-panda-muted">Couldn't load the integration catalog.</p>
          )}
        </div>
      )}
    </div>
  );
}
