import type { ChannelStatus, RebuildJob } from "../types";
import Tooltip from "./Tooltip";

interface StatusStyle {
  label: string;
  dot: string;
  pill: string;
  pulse?: boolean;
}

// Keyed by the status the backend computes (see _channel_status in
// app/routers/channels.py) so every place a channel appears agrees.
const STYLES: Record<ChannelStatus, StatusStyle> = {
  ready: { label: "Ready", dot: "bg-emerald-400", pill: "bg-emerald-500/10 text-emerald-400" },
  scanning: { label: "Scanning", dot: "bg-sky-400", pill: "bg-sky-500/10 text-sky-400", pulse: true },
  rebuilding: { label: "Rescanning", dot: "bg-sky-400", pill: "bg-sky-500/10 text-sky-400", pulse: true },
  unscanned: { label: "Not scanned", dot: "bg-slate-400", pill: "bg-slate-500/10 text-slate-400" },
  empty: { label: "No files", dot: "bg-slate-400", pill: "bg-slate-500/10 text-slate-400" },
  error: { label: "Failed", dot: "bg-red-400", pill: "bg-red-500/10 text-red-400" },
  not_joined: { label: "Not joined", dot: "bg-amber-400", pill: "bg-amber-500/10 text-amber-400" },
};

const HINTS: Record<ChannelStatus, string> = {
  ready: "Files are indexed and searchable",
  scanning: "Reading this channel's history for the first time",
  rebuilding: "Re-reading the whole history from scratch",
  unscanned: "No scan has run for this channel yet",
  empty: "Scanned, but no files matched this channel's extensions",
  error: "The last scan failed — see notifications",
  not_joined: "This account isn't a member of the channel",
};

/** A running job wins over the channel's stored status: the poll that
 *  carries it refreshes every few seconds, while the channel list is only
 *  refetched on navigation and would otherwise show a stale "Ready". */
export function effectiveStatus(status: ChannelStatus, job?: RebuildJob): ChannelStatus {
  if (job?.status === "running") return job.kind === "rebuild" ? "rebuilding" : "scanning";
  return status;
}

export default function StatusBadge({ status, job }: { status: ChannelStatus; job?: RebuildJob }) {
  const resolved = effectiveStatus(status, job);
  const style = STYLES[resolved] ?? STYLES.unscanned;
  const live = job?.status === "running" ? job : undefined;
  const label = live
    ? `${style.label} ${live.scanned.toLocaleString()}${live.total ? ` / ${live.total.toLocaleString()}` : ""}`
    : style.label;

  return (
    <Tooltip label={live ? `${live.scanned.toLocaleString()} file(s) scanned so far` : HINTS[resolved]}>
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${style.pill}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot} ${style.pulse ? "animate-pulse" : ""}`} />
        {label}
      </span>
    </Tooltip>
  );
}
