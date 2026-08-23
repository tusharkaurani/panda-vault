import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { api, ApiError } from "../../api";
import type { StreamHealthProfile, StreamHealthStatus } from "../../types";
import { timeAgoUnix } from "../../lib/time";
import { useNotifications } from "../../notifications/NotificationContext";
import ScanProgress from "../ScanProgress";

/** Stream checking: what it found last night, and a way to run it now.
 *
 *  Sits above the playlist list rather than on each row because the check is
 *  vault-wide and URL-keyed — the same stream in three playlists is one
 *  probe — so per-playlist buttons would imply an independence that doesn't
 *  exist.
 */
export default function StreamCheckPanel({ onChanged }: { onChanged: () => void }) {
  const { pushToast, jobsCompleted, healthJob } = useNotifications();
  const [status, setStatus] = useState<StreamHealthStatus | null>(null);
  const [profile, setProfile] = useState<StreamHealthProfile | null>(null);
  const [starting, setStarting] = useState(false);

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
    if (!healthJob && !status?.running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [healthJob, status?.running, load]);

  async function check() {
    if (!status) return;
    // The profile is exact where the summary is a rough estimate, so lead
    // with it when it's loaded — the numbers are the whole point of asking.
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
    setStarting(true);
    try {
      await api.playlists.checkStreams();
      pushToast("Checking streams — you'll get notified when it's done.", "info");
      load();
      loadProfile();
      onChanged();
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to start the check", "error");
    } finally {
      setStarting(false);
    }
  }

  if (!status) return null;

  const t = status.totals;
  const known = (t.available ?? 0) + (t.unavailable ?? 0) + (t.unknown ?? 0);
  const nothingToCheck = status.due === 0 && known === 0;

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
        {healthJob && <ScanProgress job={healthJob} unit="streams" />}
        <p className="text-xs text-panda-muted mt-0.5">
          {healthJob || status.running
            ? "Running now — results appear as they come in."
            : status.lastSweepAt
              ? `Last run ${timeAgoUnix(status.lastSweepAt)}. Runs again overnight.`
              : "Runs overnight, or start one now."}
        </p>
      </div>
      <button
        onClick={check}
        disabled={starting || status.running || !!healthJob || status.due === 0}
        title={
          status.due === 0
            ? "Everything has been checked recently — the next run is overnight"
            : "Check every stream URL now"
        }
        className="flex items-center gap-1.5 rounded-lg border border-panda-border px-3 py-1.5 text-sm hover:border-panda-accent disabled:opacity-50"
      >
        {starting || status.running || healthJob ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Activity size={15} />
        )}
        {status.running || healthJob ? "Checking…" : "Check now"}
      </button>
    </div>
  );
}
