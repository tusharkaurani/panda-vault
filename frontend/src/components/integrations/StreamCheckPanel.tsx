import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { api, ApiError } from "../../api";
import type { StreamHealthProfile, StreamHealthStatus } from "../../types";
import { timeAgoUnix } from "../../lib/time";
import { useNotifications } from "../../notifications/NotificationContext";

/** Stream checking: what it found last night, and a way to run it now.
 *
 *  Checking is per-playlist under the hood (health.enqueue), each with its
 *  own job and its own progress bar on that playlist's row in the list
 *  below. This panel is the vault-wide entry point — "check everything" —
 *  and shows a summary rather than one big progress bar, since there's no
 *  single job spanning every playlist any more.
 */
export default function StreamCheckPanel({ onChanged }: { onChanged: () => void }) {
  const { pushToast, jobsCompleted, healthJobs } = useNotifications();
  const [status, setStatus] = useState<StreamHealthStatus | null>(null);
  const [profile, setProfile] = useState<StreamHealthProfile | null>(null);
  const [starting, setStarting] = useState<"remaining" | "all" | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.playlists.streamHealth());
    } catch {
      // A summary is not worth an error banner; the next poll retries.
    }
  }, []);

  // Deliberately not on the 5s poll below: it walks every cached URL, and
  // the answer only changes when a check finishes.
  const loadProfile = useCallback(async () => {
    try {
      setProfile(await api.playlists.streamHealthProfile());
    } catch {
      /* the confirmation falls back to the rough estimate */
    }
  }, []);

  useEffect(() => {
    load();
    loadProfile();
  }, [load, loadProfile, jobsCompleted]);

  // While a check runs, its counts climb — poll so the numbers move. Keyed
  // off the job feed rather than status.running so the poll starts on the
  // very next tick after the job appears, not after the summary catches up.
  useEffect(() => {
    if (!healthJobs.length && !status?.running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [healthJobs.length, status?.running, load]);

  async function check(mode: "remaining" | "all") {
    if (!status) return;
    // The profile is exact where the summary is a rough estimate, so lead
    // with it when it's loaded — the numbers are the whole point of asking.
    // Both modes probe the same due URLs; "all" only differs in queuing a
    // job for a playlist with nothing outstanding too, so one estimate
    // covers either.
    const detail = profile
      ? `${profile.dueUrls.toLocaleString()} stream URLs across ${profile.hosts.toLocaleString()} providers.\n\n` +
        `That means roughly ${profile.requests.min.toLocaleString()}–${profile.requests.max.toLocaleString()} requests ` +
        `and about ${profile.approxMegabytes}MB, over ${profile.minutes.min}–${profile.minutes.max} minutes.\n\n` +
        `The range depends on how many providers turn out to be down — a dead one is ` +
        `settled with a single connection instead of probing all its channels.`
      : `${status.due.toLocaleString()} stream URLs, roughly ${status.estimatedMinutes} minutes.`;
    const ok = confirm(
      `Check streams now?\n\n${detail}\n\n` +
        `Nothing is downloaded — each stream is asked for its first couple of KB and then ` +
        `dropped. It runs slowly on purpose so providers don't rate-limit you, and you can ` +
        `keep using the app while it works.`
    );
    if (!ok) return;
    setStarting(mode);
    try {
      await api.playlists.checkAllStreams(mode);
      pushToast("Checking streams — you'll get notified as each playlist finishes.", "info");
      load();
      loadProfile();
      onChanged();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start the check", "error");
    } finally {
      setStarting(null);
    }
  }

  if (!status) return null;

  const t = status.totals;
  const known = (t.available ?? 0) + (t.unavailable ?? 0) + (t.unknown ?? 0);
  const nothingToCheck = status.due === 0 && known === 0;
  const runningNow = healthJobs.filter((j) => j.status === "running").length;
  const waitingCount = healthJobs.length - runningNow;

  return (
    <div className="rounded-lg border border-panda-border bg-panda-surface px-4 py-3 flex items-start gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-panda-muted shrink-0" />
          <h3 className="text-sm font-medium">Stream check</h3>
        </div>
        {nothingToCheck ? (
          <p className="text-xs text-panda-muted mt-1">
            Add a playlist and its streams get checked on the next nightly run.
          </p>
        ) : (
          <p className="text-xs text-panda-muted mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
            {known > 0 && (
              <>
                <span className="text-emerald-400">{(t.available ?? 0).toLocaleString()} working</span>
                <span>·</span>
                <span className="text-red-400">{(t.unavailable ?? 0).toLocaleString()} not working</span>
                {!!t.unknown && (
                  <>
                    <span>·</span>
                    <span className="text-amber-400">{t.unknown.toLocaleString()} didn't answer</span>
                  </>
                )}
              </>
            )}
            {!!t.unchecked && (
              <>
                {known > 0 && <span>·</span>}
                <span>{t.unchecked.toLocaleString()} not checked</span>
              </>
            )}
          </p>
        )}
        {profile && profile.dueUrls > 0 && !status.running && (
          <p className="text-xs text-panda-muted mt-0.5">
            Next run: {profile.dueUrls.toLocaleString()} URLs across{" "}
            {profile.hosts.toLocaleString()} providers ·{" "}
            {profile.requests.min.toLocaleString()}–{profile.requests.max.toLocaleString()} requests ·{" "}
            ~{profile.approxMegabytes}MB · {profile.minutes.min}–{profile.minutes.max} min
          </p>
        )}
        <p className="text-xs text-panda-muted mt-0.5">
          {healthJobs.length > 0
            ? `Checking now — ${runningNow} playlist in progress${waitingCount ? `, ${waitingCount} queued` : ""}. See each playlist's row for progress.`
            : status.lastSweepAt
              ? `Last run ${timeAgoUnix(status.lastSweepAt)}. Runs again overnight.`
              : "Runs overnight, or start one now."}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => check("remaining")}
          disabled={!!starting || status.due === 0}
          title={
            status.due === 0
              ? "Everything has been checked recently — the next run is overnight"
              : "Check only playlists with something outstanding"
          }
          className="flex items-center gap-1.5 rounded-lg border border-panda-border px-3 py-1.5 text-sm hover:border-panda-accent disabled:opacity-50"
        >
          {starting === "remaining" ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />}
          Scan remaining
        </button>
        <button
          onClick={() => check("all")}
          disabled={!!starting}
          title="Check every playlist now, even ones checked recently"
          className="flex items-center gap-1.5 rounded-lg border border-panda-border px-3 py-1.5 text-sm hover:border-panda-accent disabled:opacity-50"
        >
          {starting === "all" ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />}
          Scan all
        </button>
      </div>
    </div>
  );
}
