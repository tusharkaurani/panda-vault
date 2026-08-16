import { Link } from "react-router-dom";
import { FolderTree } from "lucide-react";
import type { CollectionRef } from "../lib/collections";

/** Where a channel's documents surface in the library: one pill per
 *  collection bound to it, each linking to that collection. Ancestor names
 *  are shown inline (muted) so two same-named leaves under different
 *  parents stay distinguishable without hovering. */
export default function ChannelCollections({ collections }: { collections: CollectionRef[] }) {
  if (collections.length === 0) {
    return <p className="text-xs text-panda-muted mt-1.5">Not in any collection yet</p>;
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
      <FolderTree size={13} className="text-panda-muted shrink-0" />
      {collections.map((c) => (
        <Link
          key={c.id}
          to={`/c/${c.id}`}
          className="rounded-full border border-panda-border bg-panda-surface2 px-2 py-0.5 text-[11px] text-panda-text hover:border-panda-accent hover:text-panda-accent transition-colors"
        >
          {c.path.slice(0, -1).map((ancestor) => (
            <span key={ancestor} className="text-panda-muted">
              {ancestor} /{" "}
            </span>
          ))}
          {c.name}
        </Link>
      ))}
    </div>
  );
}
