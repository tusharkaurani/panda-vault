import { forwardRef } from "react";
import { Link } from "react-router-dom";
import {
  Folder as FolderIcon,
  Newspaper,
  BookOpen,
  Film,
  Music,
  Archive,
  GripVertical,
  Radio,
  Tv,
} from "lucide-react";
import type { Collection } from "../types";
import Tooltip from "./Tooltip";

const ICONS: Record<string, typeof FolderIcon> = {
  folder: FolderIcon,
  newspaper: Newspaper,
  book: BookOpen,
  film: Film,
  music: Music,
  archive: Archive,
  channel: Radio,
};

export interface DragHandlers {
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onHandleKeyDown: (e: React.KeyboardEvent) => void;
  dragging: boolean;
  position: string; // "2 of 7", for the handle's accessible name
}

function countParts(collection: Collection): string[] {
  const fileCount = collection.fileCount ?? 0;
  // An M3U collection holds live streams, not files — counting them in
  // "files" reads as though something is downloadable when nothing is.
  const unit =
    collection.sourceType === "m3u"
      ? fileCount === 1 ? "entry" : "entries"
      : fileCount === 1 ? "file" : "files";
  const fileLabel = `${fileCount.toLocaleString()} ${unit}`;
  if (collection.sourceIds.length > 0) return [fileLabel];
  const folderCount = collection.folderCount ?? collection.children.length;
  return [`${folderCount.toLocaleString()} collection${folderCount === 1 ? "" : "s"}`, fileLabel];
}

/** A card in a collection grid. Channel-bound leaves and container
 *  collections share one look — only the icon separates them, so the grid
 *  stays visually uniform while still telling you which cards bottom out at
 *  a document list. */
const CollectionCard = forwardRef<HTMLDivElement, { collection: Collection; drag?: DragHandlers }>(
  function CollectionCard({ collection, drag }, ref) {
    const isBound = collection.sourceIds.length > 0;
    const BoundIcon = collection.sourceType === "m3u" ? Tv : Radio;
    const Icon = isBound ? BoundIcon : (collection.icon && ICONS[collection.icon]) || FolderIcon;

    return (
      <div
        ref={ref}
        // Dragging is owned by this wrapper, not the Link — an anchor is
        // natively draggable and would otherwise hijack the gesture to drag
        // its URL instead of reordering.
        draggable={!!drag}
        onDragStart={drag?.onDragStart}
        onDragEnter={drag?.onDragEnter}
        onDragOver={drag ? (e) => e.preventDefault() : undefined}
        onDrop={drag ? (e) => e.preventDefault() : undefined}
        onDragEnd={drag?.onDragEnd}
        className={`group relative rounded-xl border border-panda-border bg-panda-surface transition-all hover:-translate-y-0.5 hover:border-panda-accent ${
          drag?.dragging ? "opacity-40" : ""
        }`}
      >
        {drag && (
          <Tooltip label="Drag to reorder — or focus and use the arrow keys">
            <button
              type="button"
              draggable
              onDragStart={drag.onDragStart}
              onKeyDown={drag.onHandleKeyDown}
              aria-label={`Reorder ${collection.name}, position ${drag.position}`}
              className="absolute right-1.5 top-1.5 z-10 cursor-grab rounded-md p-1 text-panda-muted opacity-0 transition-opacity hover:text-panda-text focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
            >
              <GripVertical size={14} />
            </button>
          </Tooltip>
        )}

        <Link to={`/c/${collection.id}`} draggable={false} className="flex h-full flex-col gap-3 p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="shrink-0 rounded-lg bg-panda-surface2 p-2.5 text-panda-accent group-hover:bg-panda-accent/10">
              <Icon size={22} />
            </div>
            <div className="text-right text-[11px] uppercase leading-snug tracking-wide text-panda-muted">
              {countParts(collection).map((part, i) => (
                <div key={i} className="whitespace-nowrap tabular-nums">
                  {part}
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="font-medium leading-tight">{collection.name}</h3>
            {collection.description && (
              <p className="mt-1 line-clamp-2 text-sm text-panda-muted">{collection.description}</p>
            )}
          </div>
        </Link>
      </div>
    );
  }
);

export default CollectionCard;
