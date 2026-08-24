import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RebuildJob } from "../types";

export type ToastKind = "success" | "error" | "info";

interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface Notification {
  id: string;
  kind: "success" | "error";
  title: string;
  message: string;
  createdAt: number;
  read: boolean;
}

interface NotificationContextValue {
  toasts: Toast[];
  pushToast: (message: string, kind?: ToastKind) => void;
  dismissToast: (id: string) => void;
  notifications: Notification[];
  unreadCount: number;
  // Live scan/rebuild/health jobs keyed by source, plus a counter that ticks
  // whenever one finishes — components use it as an effect dependency to
  // refetch the counts a completed job just changed.
  jobsBySource: Record<string, RebuildJob>;
  /** Every stream check that's queued or running right now, across every
   *  playlist — the vault-wide panel's summary reads this; a single
   *  playlist's own progress reads jobsBySource[playlistId] instead. */
  healthJobs: RebuildJob[];
  jobsCompleted: number;
  markAllRead: () => void;
  dismissNotification: (id: string) => void;
  clearAllNotifications: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const NOTIFICATIONS_KEY = "pv_notifications";
const SEEN_JOBS_KEY = "pv_seen_rebuild_jobs";

function loadNotifications(): Notification[] {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function loadSeenJobs(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_JOBS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

/** A channel's first pass is a "Scan"; a manual full pass over a channel
 *  that was already cached is a "Rescan". */
function verb(job: RebuildJob): string {
  // Probing stream URLs isn't a scan of a source at all — it spans every
  // playlist at once — so it gets its own word.
  if (job.kind === "health") return "Stream check";
  // A playlist is fetched whole rather than scanned message by message, and
  // the notification is the only place a user sees the work named.
  if (job.sourceType === "m3u") return job.kind === "rebuild" ? "Re-fetch" : "Fetch";
  return job.kind === "rebuild" ? "Rescan" : "Scan";
}

function counted(job: RebuildJob): string {
  const n = job.scanned.toLocaleString();
  if (job.kind === "health") return `${n} stream${job.scanned === 1 ? "" : "s"} checked`;
  if (job.sourceType === "m3u") return `${n} channel${job.scanned === 1 ? "" : "s"}`;
  return `${n} file${job.scanned === 1 ? "" : "s"}`;
}

function persistSeenJobs(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_JOBS_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* ignore */
  }
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jobsBySource, setJobsBySource] = useState<Record<string, RebuildJob>>({});
  const [healthJobs, setHealthJobs] = useState<RebuildJob[]>([]);
  const [jobsCompleted, setJobsCompleted] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>(loadNotifications);
  // Tracks which rebuild jobs have already produced a notification, kept
  // separate from `notifications` itself so clearing the list doesn't cause
  // an already-seen completion to resurface on the next poll.
  const seenJobs = useRef<Set<string>>(loadSeenJobs());
  // Jobs observed mid-flight. The server tracks jobs in memory only, so a
  // restart drops them — anything that was running and then disappears
  // without a terminal status was interrupted, and must be reported rather
  // than polled for forever.
  const runningJobs = useRef<Map<string, RebuildJob>>(new Map());

  useEffect(() => {
    try {
      localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications.slice(0, 50)));
    } catch {
      /* ignore */
    }
  }, [notifications]);

  const pushToast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const addNotification = useCallback((n: Omit<Notification, "createdAt" | "read">) => {
    setNotifications((list) => [{ ...n, createdAt: Date.now(), read: false }, ...list].slice(0, 50));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((list) => (list.some((n) => !n.read) ? list.map((n) => ({ ...n, read: true })) : list));
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((list) => list.filter((n) => n.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => setNotifications([]), []);

  const markSeen = useCallback((jobId: string) => {
    seenJobs.current.add(jobId);
    persistSeenJobs(seenJobs.current);
  }, []);

  // Poll rebuild jobs so completions surface here (and as a toast) even if
  // the user has navigated away from Settings since starting one.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.jobs.list();
        if (cancelled) return;
        let finished = 0;
        const live = new Set(res.jobs.map((j) => j.id));
        for (const [id, prev] of runningJobs.current) {
          if (live.has(id)) continue;
          runningJobs.current.delete(id);
          finished++;
          if (seenJobs.current.has(id)) continue;
          markSeen(id);
          // Silent (nightly) jobs are tracked here like any other so a
          // playlist's row can show progress, but never produce a
          // notification-bell entry — routine housekeeping shouldn't page.
          if (prev.silent) continue;
          addNotification({
            id,
            kind: "error",
            title: `${verb(prev)} interrupted`,
            message: `"${prev.sourceName}" stopped before finishing — the server restarted. Try again.`,
          });
          pushToast(`${verb(prev)} interrupted for "${prev.sourceName}"`, "error");
        }
        for (const job of res.jobs) {
          // A queued stream check hasn't started yet, but tracking it the
          // same way a running one is tracked is what lets its row show a
          // "waiting" state, and what lets a restart before it ever starts
          // still be reported as interrupted above.
          if (job.status === "running" || job.status === "queued") {
            runningJobs.current.set(job.id, job);
            continue;
          }
          if (runningJobs.current.delete(job.id)) finished++;
          if (seenJobs.current.has(job.id)) continue;
          markSeen(job.id);
          if (job.silent) continue;
          if (job.status === "done") {
            addNotification({
              id: job.id,
              kind: "success",
              title: `${verb(job)} complete`,
              message: `"${job.sourceName}" finished with ${counted(job)}.`,
            });
            pushToast(`${verb(job)} complete for "${job.sourceName}"`, "success");
          } else {
            addNotification({
              id: job.id,
              kind: "error",
              title: `${verb(job)} failed`,
              message: `"${job.sourceName}": ${job.error || "unknown error"}`,
            });
            pushToast(`${verb(job)} failed for "${job.sourceName}"`, "error");
          }
        }
        const running = [...runningJobs.current.values()];
        setJobsBySource(Object.fromEntries(running.map((j) => [j.sourceId, j])));
        setHealthJobs(running.filter((j) => j.kind === "health"));
        if (finished) setJobsCompleted((n) => n + finished);
      } catch {
        // transient network hiccup — next tick retries
      }
    }
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [addNotification, pushToast, markSeen]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        toasts,
        pushToast,
        dismissToast,
        notifications,
        unreadCount,
        jobsBySource,
        healthJobs,
        jobsCompleted,
        markAllRead,
        dismissNotification,
        clearAllNotifications,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationProvider");
  return ctx;
}
