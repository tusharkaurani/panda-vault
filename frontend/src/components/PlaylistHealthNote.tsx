import { AlertTriangle } from "lucide-react";
import type { Playlist, RebuildJob } from "../types";
import { timeAgoUnix } from "../lib/time";
import { effectiveStatus } from "./StatusBadge";

/** What a playlist's last fetch says about it, in the settings list.
 *
 *  The status pill can only say *that* something is wrong in two words. The
 *  useful part is which of three quite different things happened — the URL
 *  stopped answering, it answered with something that isn't a playlist, or
 *  it answered with far less than before — because only the third one has
 *  an action attached, and only the user can take it.
 *
 *  Reads `status` rather than re-deriving from `fetchStatus`/`failStreak`,
 *  so the note and the pill can never disagree about whether a single
 *  failed fetch is worth mentioning (jobs.source_status decides).
 */
export default function PlaylistHealthNote({
  playlist,
  job,
  onReplaceAnyway,
  busy,
}: {
  playlist: Playlist;
  job?: RebuildJob;
  onReplaceAnyway: () => void;
  busy?: boolean;
}) {
  const status = effectiveStatus(playlist.status, job);
  const lastOk = playlist.lastOkAt ? timeAgoUnix(playlist.lastOkAt) : null;

  if (status !== "stale" && status !== "invalid" && status !== "needs_review") {
    // Healthy: the only thing worth a line is when it last actually ran,
    // which is the whole point of putting it on a schedule.
    return lastOk ? (
      <p className="text-xs text-panda-muted mt-0.5">Updated {lastOk}</p>
    ) : null;
  }

  const shrunk = status === "needs_review";

  return (
    <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1 text-xs">
        <p className="text-amber-300">
          {playlist.fetchError ?? "The last fetch did not work."}
        </p>
        <p className="text-panda-muted mt-0.5">
          {lastOk ? `Last worked ${lastOk}. ` : ""}
          {shrunk
            ? "The entries below are the previous copy."
            : "The entries below are the last copy that worked, and are no longer being updated."}
        </p>
        {shrunk && (
          <button
            onClick={onReplaceAnyway}
            disabled={busy}
            className="mt-1.5 rounded-md border border-amber-500/40 px-2 py-1 font-medium text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
          >
            Replace anyway
          </button>
        )}
      </div>
    </div>
  );
}
