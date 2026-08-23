import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { DocumentOut } from "../types";
import { initialsFor, logoSrc } from "../lib/logos";
import CopyLinkButton from "./CopyLinkButton";
import StreamHealthDot from "./StreamHealthDot";
import Tooltip from "./Tooltip";

/** The extension the stream URL ends in — the same thing a playlist's
 *  allowedExtensions filters on, so it's worth surfacing. */
function streamExt(url?: string | null): string | null {
  if (!url) return null;
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop() || "";
  if (!last.includes(".")) return null;
  return last.split(".").pop()!.toLowerCase().slice(0, 6);
}

/** One M3U entry. The counterpart to DocumentRow, which can't be reused: an
 *  entry is a live stream, so there is no size, no download, and a logo and
 *  group where a file icon and byte count would be. */
export default function EntryRow({ doc, sourceName }: { doc: DocumentOut; sourceName?: string }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = logoFailed ? null : logoSrc(doc.logo);
  const ext = streamExt(doc.url);

  return (
    <a
      href={doc.url ?? undefined}
      target="_blank"
      // noreferrer as well as noopener: providers key off the Referer header
      // and some reject a request that arrives with an unexpected one.
      rel="noopener noreferrer"
      className={`doc-row group flex items-center gap-3 rounded-lg border border-panda-border bg-panda-surface px-4 py-3 hover:border-panda-accent transition-colors ${
        // Dimmed, never disabled: a probe can be wrong (geo-blocks, a
        // provider that only answers real players) and the link is still
        // worth a try.
        doc.health === "unavailable" ? "opacity-60" : ""
      }`}
    >
      <div className="shrink-0 h-10 w-10 rounded-md bg-panda-surface2 border border-panda-border overflow-hidden flex items-center justify-center">
        {logo ? (
          <img
            src={logo}
            alt=""
            loading="lazy"
            // Logos come from third-party hosts; don't leak where the request
            // originated, and don't let one send cookies.
            referrerPolicy="no-referrer"
            onError={() => setLogoFailed(true)}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-[10px] font-semibold tracking-wide text-panda-muted">
            {initialsFor(doc.name)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <StreamHealthDot health={doc.health} checkedAt={doc.healthCheckedAt} />
          <span className="truncate">{doc.name}</span>
        </p>
        <p className="flex items-center gap-1.5 flex-wrap text-xs text-panda-muted">
          {doc.group && (
            <span className="rounded-full bg-panda-surface2 border border-panda-border px-1.5 py-0.5">
              {doc.group}
            </span>
          )}
          {ext && <span className="font-mono uppercase">{ext}</span>}
          {sourceName && <span>· {sourceName}</span>}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {doc.url && (
          <CopyLinkButton
            url={doc.url}
            label="Copy stream URL"
            size={16}
            className="p-1 rounded-md text-panda-muted hover:text-panda-accent"
          />
        )}
        <Tooltip label="Open the stream">
          <span className="p-1 text-panda-muted group-hover:text-panda-accent">
            <ExternalLink size={16} />
          </span>
        </Tooltip>
      </div>
    </a>
  );
}
