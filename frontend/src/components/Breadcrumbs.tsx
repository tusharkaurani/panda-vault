import { Fragment, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  /** Where this crumb goes. Omit for a crumb that names a level with no page
   *  of its own — "Settings" is one: it redirects to whichever tab is
   *  default, so linking it would just duplicate the crumb after it. */
  to?: string;
  icon?: ReactNode;
}

/** The trail above a page's title.
 *
 *  Trails are rooted at their *section*, not at a universal home: a Library
 *  trail starts at Library because `/` really is the parent of a collection,
 *  while a Settings trail starts at Settings, because Settings is a peer of
 *  the Library and never a child of it. Getting home is the header logo's
 *  job (`Layout`), which is on screen either way. */
export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="flex items-center gap-1 text-sm text-panda-muted flex-wrap">
      {items.map((item, i) => {
        // The last crumb is the page you're on: never a link, even when it
        // carries a `to` for the sake of a uniform caller.
        const current = i === items.length - 1;
        const body = (
          <>
            {item.icon}
            {item.label}
          </>
        );
        return (
          <Fragment key={`${item.label}-${i}`}>
            {i > 0 && <ChevronRight size={14} />}
            {current ? (
              <span className="flex items-center gap-1 text-panda-text font-medium">{body}</span>
            ) : item.to ? (
              <Link to={item.to} className="flex items-center gap-1 hover:text-panda-accent">
                {body}
              </Link>
            ) : (
              <span className="flex items-center gap-1">{body}</span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
