import type { DocumentOut } from "../types";
import DocumentRow from "./DocumentRow";
import EntryRow from "./EntryRow";

/** Picks the row for whatever kind of item this is.
 *
 *  Global search returns Telegram documents and M3U entries interleaved in
 *  one page, so the choice can't live at the page level — it has to be made
 *  per row, from the row's own sourceType. */
export default function ItemRow({ doc, sourceName }: { doc: DocumentOut; sourceName?: string }) {
  return doc.sourceType === "m3u" ? (
    <EntryRow doc={doc} sourceName={sourceName} />
  ) : (
    <DocumentRow doc={doc} sourceName={sourceName} />
  );
}
