import type { RebuildJob, SourceStatus, SourceType } from "../types";
import Tooltip from "./Tooltip";

interface StatusStyle {
  label: string;
  dot: string;
  pill: string;
  pulse?: boolean;
}

// Keyed by the status the backend computes (see jobs.source_status) so
// every place a source appears agrees.
const STYLES: Record<SourceStatus, StatusStyle> = {
  ready: { label: "Ready", dot: "bg-emerald-400", pill: "bg-emerald-500/10 text-emerald-400" },
  scanning: { label: "Scanning", dot: "bg-sky-400", pill: "bg-sky-500/10 text-sky-400", pulse: true },
  rebuilding: { label: "Rescanning", dot: "bg-sky-400", pill: "bg-sky-500/10 text-sky-400", pulse: true },
  unscanned: { label: "Not scanned", dot: "bg-slate-400", pill: "bg-slate-500/10 text-slate-400" },
  empty: { label: "No files", dot: "bg-slate-400", pill: "bg-slate-500/10 text-slate-400" },
  error: { label: "Failed", dot: "bg-red-400", pill: "bg-red-500/10 text-red-400" },
  not_joined: { label: "Not joined", dot: "bg-amber-400", pill: "bg-amber-500/10 text-amber-400" },
  // Amber rather than red: in all three the cached entries are still there
  // and still browsable — what has broken is the updating, not the content.
  stale: { label: "Not updating", dot: "bg-amber-400", pill: "bg-amber-500/10 text-amber-400" },
  invalid: { label: "Bad URL", dot: "bg-amber-400", pill: "bg-amber-500/10 text-amber-400" },
  needs_review: { label: "Needs review", dot: "bg-amber-400", pill: "bg-amber-500/10 text-amber-400" },
};

// A playlist is fetched rather than scanned, holds TV channels rather than
// files, and can never be `not_joined` — there is nothing to join.
const HINTS: Record<SourceType, Record<SourceStatus, string>> = {
  telegram: {
    ready: "Files are indexed and searchable",
    scanning: "Reading this channel's history for the first time",
    rebuilding: "Re-reading the whole history from scratch",
    unscanned: "No scan has run for this channel yet",
    empty: "Scanned, but no files matched this channel's extensions",
    error: "The last scan failed — see notifications",
    not_joined: "This account isn't a member of the channel",
    stale: "Not applicable to a channel",
    invalid: "Not applicable to a channel",
    needs_review: "Not applicable to a channel",
  },
  m3u: {
    ready: "Channels are indexed and searchable",
    scanning: "Fetching this playlist for the first time",
    rebuilding: "Re-fetching the whole playlist",
    unscanned: "This playlist hasn't been fetched yet",
    empty: "Fetched, but no channels matched this playlist's extensions",
    error: "The last fetch failed — see notifications",
    not_joined: "Not applicable to a playlist",
    stale: "The URL has stopped answering — showing the last copy that worked",
    invalid: "The URL answers, but no longer with a playlist — showing the last copy that worked",
    needs_review: "The newest copy was far smaller, so it was refused — rescan to accept it anyway",
  },
};

/** A running job wins over the channel's stored status: the poll that
 *  carries it refreshes every few seconds, while the channel list is only
 *  refetched on navigation and would otherwise show a stale "Ready". */
export function effectiveStatus(status: SourceStatus, job?: RebuildJob): SourceStatus {
  if (job?.status === "running") return job.kind === "rebuild" ? "rebuilding" : "scanning";
  return status;
}

export default function StatusBadge({
  status,
  job,
  sourceType = "telegram",
}: {
  status: SourceStatus;
  job?: RebuildJob;
  sourceType?: SourceType;
}) {
  const resolved = effectiveStatus(status, job);
  const style = STYLES[resolved] ?? STYLES.unscanned;
  const unit = sourceType === "m3u" ? "channel" : "file";
  const live = job?.status === "running" ? job : undefined;
  const baseLabel = resolved === "empty" && sourceType === "m3u" ? "No channels" : style.label;
  const label = live
    ? `${baseLabel} ${live.scanned.toLocaleString()}${live.total ? ` / ${live.total.toLocaleString()}` : ""}`
    : baseLabel;

  return (
    <Tooltip
      label={
        live
          ? `${live.scanned.toLocaleString()} ${unit}s scanned so far`
          : HINTS[sourceType][resolved]
      }
    >
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${style.pill}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot} ${style.pulse ? "animate-pulse" : ""}`} />
        {label}
      </span>
    </Tooltip>
  );
}
