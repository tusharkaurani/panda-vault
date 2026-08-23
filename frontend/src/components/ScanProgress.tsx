import type { RebuildJob } from "../types";

/** Progress bar for an in-flight scan/rebuild. `total` is Telegram's own
 *  count of matching files, which only arrives with the first batch — until
 *  then there's no denominator, so the bar runs indeterminate rather than
 *  inventing one. */
export default function ScanProgress({ job, unit = "files" }: { job: RebuildJob; unit?: string }) {
  const pct = job.total ? Math.min(100, Math.round((job.scanned / job.total) * 100)) : null;

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-panda-surface2">
        {pct === null ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-400/70" />
        ) : (
          <div className="h-full rounded-full bg-sky-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        )}
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-panda-muted">
        {job.scanned.toLocaleString()}
        {job.total ? ` / ${job.total.toLocaleString()}` : ""} {unit}
        {pct !== null && ` · ${pct}%`}
      </span>
    </div>
  );
}
