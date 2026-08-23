import { Link } from "react-router-dom";
import { Tag } from "lucide-react";
import type { GroupSummary } from "../types";

/** The URL segment for a category — `""` (the "Other channels" bucket)
 *  isn't a valid path segment on its own, so it gets a sentinel unlikely to
 *  collide with a real category name. Kept next to `groupParamFromUrl`, its
 *  inverse, so the two can't drift apart. */
const UNGROUPED_SLUG = "__ungrouped__";

export function groupUrlSlug(name: string): string {
  return encodeURIComponent(name || UNGROUPED_SLUG);
}

/** The inverse of `groupUrlSlug` — what a group detail page reads its route
 *  param back as. React Router already decodes path params, so this only
 *  needs to undo the ungrouped sentinel. */
export function groupParamFromUrl(slug: string): string {
  return slug === UNGROUPED_SLUG ? "" : slug;
}

/** The Grouped view's overview: one folder-style card per category, each
 *  linking to that category's own page. Deliberately no channel tiles here —
 *  a category can hold hundreds of channels, and this is a table of
 *  contents, not the browsing surface itself. */
export default function GroupedChannels({ collectionId, groups }: { collectionId: string; groups: GroupSummary[] }) {
  return (
    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {groups.map((g) => (
        <Link
          key={g.name || UNGROUPED_SLUG}
          to={`/c/${collectionId}/group/${groupUrlSlug(g.name)}`}
          className="group flex flex-col gap-3 rounded-xl border border-panda-border bg-panda-surface p-5 transition-all hover:-translate-y-0.5 hover:border-panda-accent"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="shrink-0 rounded-lg bg-panda-surface2 p-2.5 text-panda-accent group-hover:bg-panda-accent/10">
              <Tag size={22} />
            </div>
            <div className="text-right text-[11px] uppercase leading-snug tracking-wide text-panda-muted">
              <div className="whitespace-nowrap tabular-nums">
                {g.count.toLocaleString()} channel{g.count === 1 ? "" : "s"}
              </div>
            </div>
          </div>
          <h3 className="font-medium leading-tight">{g.name || "Other channels"}</h3>
        </Link>
      ))}
    </div>
  );
}
