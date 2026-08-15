import { Link } from "react-router-dom";
import { Folder as FolderIcon, Newspaper, BookOpen, Film, Music, Archive, MessageSquare } from "lucide-react";
import type { Collection } from "../types";

const ICONS: Record<string, typeof FolderIcon> = {
  folder: FolderIcon,
  newspaper: Newspaper,
  book: BookOpen,
  film: Film,
  music: Music,
  archive: Archive,
  channel: MessageSquare,
};

function countLabel(collection: Collection): string {
  const fileCount = collection.fileCount ?? 0;
  const fileLabel = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  if (collection.channelIds.length > 0) return fileLabel;
  const folderCount = collection.folderCount ?? collection.children.length;
  const folderLabel = `${folderCount} collection${folderCount === 1 ? "" : "s"}`;
  return `${folderLabel} · ${fileLabel}`;
}

export default function CollectionCard({ collection }: { collection: Collection }) {
  const Icon = (collection.icon && ICONS[collection.icon]) || FolderIcon;

  return (
    <Link
      to={`/c/${collection.id}`}
      className="group flex flex-col gap-3 rounded-xl border border-panda-border bg-panda-surface p-5 hover:border-panda-accent hover:-translate-y-0.5 transition-all"
    >
      <div className="flex items-center justify-between">
        <div className="p-2.5 rounded-lg bg-panda-surface2 text-panda-accent group-hover:bg-panda-accent/10">
          <Icon size={22} />
        </div>
        <span className="text-[11px] uppercase tracking-wide text-panda-muted">{countLabel(collection)}</span>
      </div>
      <div>
        <h3 className="font-medium leading-tight">{collection.name}</h3>
        {collection.description && <p className="text-sm text-panda-muted mt-1 line-clamp-2">{collection.description}</p>}
      </div>
    </Link>
  );
}
