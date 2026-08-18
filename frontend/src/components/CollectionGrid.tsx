import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Collection } from "../types";
import CollectionCard from "./CollectionCard";
import ErrorBanner from "./ErrorBanner";

const idsOf = (list: Collection[]) => list.map((c) => c.id).join(",");

/** The grid of collection cards, reorderable by drag or keyboard.
 *
 *  Sibling order is the stored order (`collections.json` is a plain list), so
 *  a drop rewrites that whole level via `/collections/reorder` — `parentId`
 *  is which level, `null` for the library root.
 *
 *  Reordering is optimistic: the cards follow the pointer immediately and the
 *  save happens on drop. A rejected save (409 when another tab has changed
 *  the tree meanwhile) restores the order captured at drag start, so the grid
 *  never sits in a state the server didn't accept.
 */
export default function CollectionGrid({
  collections,
  parentId,
}: {
  collections: Collection[];
  parentId: string | null;
}) {
  const [items, setItems] = useState(collections);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Order as it was before the current gesture — the target to roll back to.
  const snapshot = useRef<Collection[]>(collections);

  useEffect(() => {
    setItems(collections);
    snapshot.current = collections;
  }, [collections]);

  const reorderable = items.length > 1;

  async function persist(next: Collection[]) {
    if (idsOf(next) === idsOf(snapshot.current)) return;
    const rollback = snapshot.current;
    setError(null);
    try {
      await api.collections.reorder(
        parentId,
        next.map((c) => c.id)
      );
      snapshot.current = next;
    } catch (e) {
      setItems(rollback);
      setError(e instanceof ApiError ? e.message : "Couldn't save the new order");
    }
  }

  function moveTo(id: string, toIndex: number) {
    setItems((prev) => {
      const from = prev.findIndex((c) => c.id === id);
      if (from < 0 || toIndex < 0 || toIndex >= prev.length || from === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function moveBy(id: string, delta: number) {
    const from = items.findIndex((c) => c.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
    persist(next);
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorBanner message={error} />}
      <div
        className="grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4"
        // Without a container-level dragover the gaps between cards reject
        // the drop, which cancels the gesture and snaps the grid back.
        onDragOver={(e) => e.preventDefault()}
      >
        {items.map((c, i) => (
          <CollectionCard
            key={c.id}
            collection={c}
            drag={
              reorderable
                ? {
                    dragging: dragId === c.id,
                    position: `${i + 1} of ${items.length}`,
                    onDragStart: () => {
                      snapshot.current = items;
                      setDragId(c.id);
                    },
                    onDragEnter: () => {
                      if (dragId && dragId !== c.id) moveTo(dragId, i);
                    },
                    onDragEnd: () => {
                      setDragId(null);
                      persist(items);
                    },
                    onHandleKeyDown: (e) => {
                      const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
                      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
                      if (!back && !fwd) return;
                      e.preventDefault();
                      moveBy(c.id, back ? -1 : 1);
                    },
                  }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
