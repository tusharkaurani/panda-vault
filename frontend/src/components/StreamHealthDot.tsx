import type { StreamHealth } from "../types";
import { timeAgoUnix } from "../lib/time";
import Tooltip from "./Tooltip";

/** What each state means to someone looking at a channel list. Amber for
 *  `unknown` rather than red is the whole point of that state existing: one
 *  failed probe is a provider glitch or a wobbly connection, not evidence a
 *  channel is gone, so it is reported as doubt rather than a verdict. */
const STYLES: Record<StreamHealth, { dot: string; label: string }> = {
  available: { dot: "bg-emerald-400", label: "Working" },
  unavailable: { dot: "bg-red-400", label: "Not working" },
  unknown: { dot: "bg-amber-400", label: "Didn't answer" },
  unchecked: { dot: "bg-slate-500", label: "Not checked yet" },
};

const DETAIL: Record<StreamHealth, string> = {
  available: "Answered when it was last checked",
  unavailable: "Failed twice in a row — the stream is very likely gone",
  unknown: "Didn't answer last time. It gets another chance before being called dead",
  unchecked: "No check has run against this stream yet",
};

/** A stream's reachability, as a dot beside its name.
 *
 *  A dot rather than a pill because a channel list is hundreds of rows and
 *  the health of any one of them is secondary to its name — the colour is
 *  there to be scanned past, and read only when something is wrong. */
export default function StreamHealthDot({
  health,
  checkedAt,
}: {
  health?: StreamHealth | null;
  checkedAt?: number | null;
}) {
  if (!health) return null;
  const style = STYLES[health];
  const when = checkedAt ? ` · checked ${timeAgoUnix(checkedAt)}` : "";

  return (
    <Tooltip label={`${style.label} — ${DETAIL[health]}${when}`}>
      <span className="inline-flex items-center shrink-0" aria-label={style.label}>
        <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      </span>
    </Tooltip>
  );
}
