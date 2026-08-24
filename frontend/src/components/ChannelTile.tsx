import { useState } from "react";
import { Play } from "lucide-react";
import type { DocumentOut } from "../types";
import { initialsFor, logoSrc } from "../lib/logos";
import { isPlayableStream } from "../lib/streams";
import StreamHealthDot from "./StreamHealthDot";
import StreamPlayerModal from "./StreamPlayerModal";
import Tooltip from "./Tooltip";

/** One channel inside a group's page — a tile large enough that the logo
 *  and the full name are both actually readable, unlike the overview's
 *  compact folder cards. */
export default function ChannelTile({ doc }: { doc: DocumentOut }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const logo = logoFailed ? null : logoSrc(doc.logo);
  const playable = isPlayableStream(doc.url);

  return (
    <a
      href={doc.url ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      title={doc.name}
      className={`group relative flex flex-col items-center gap-3 rounded-xl border border-panda-border bg-panda-surface2 p-4 text-center transition-colors hover:border-panda-accent ${
        doc.health === "unavailable" ? "opacity-60" : ""
      }`}
    >
      <div className="relative flex h-48 w-48 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-panda-border bg-panda-surface">
        {logo ? (
          <img
            src={logo}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setLogoFailed(true)}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-2xl font-semibold tracking-wide text-panda-muted">{initialsFor(doc.name)}</span>
        )}
        {doc.health && (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-panda-surface p-0.5">
            <StreamHealthDot health={doc.health} checkedAt={doc.healthCheckedAt} />
          </span>
        )}
      </div>
      <span className="w-full truncate text-base font-medium">{doc.name}</span>
      {playable && (
        <Tooltip label="Play in browser">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setPlayerOpen(true);
            }}
            className="absolute right-2 top-2 rounded-md bg-panda-surface p-1.5 text-panda-muted opacity-0 shadow group-hover:opacity-100 hover:text-panda-accent"
          >
            <Play size={16} />
          </button>
        </Tooltip>
      )}
      {playerOpen && playable && doc.url && (
        <StreamPlayerModal url={doc.url} name={doc.name} onClose={() => setPlayerOpen(false)} />
      )}
    </a>
  );
}
