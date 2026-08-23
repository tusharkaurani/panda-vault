import type { CollectionRef } from "../../lib/collections";
import type { Integration } from "../../types";

/** What every integration's settings panel is handed. A panel owns its own
 *  source list — the page above it only knows about the catalog entry and the
 *  collection tree, which are the same for every source type. */
export interface IntegrationPanelProps {
  integration: Integration;
  /** Reverse index of the collection tree, by source id. `null` until the
   *  tree has loaded, so a panel can hold off on rendering "appears in …". */
  sourceCollections: Record<string, CollectionRef[]> | null;
  /** Something changed that the page's own data depends on — a source added
   *  or removed, an account connected. Re-pulls the tree and the catalog. */
  onChanged: () => void;
}
