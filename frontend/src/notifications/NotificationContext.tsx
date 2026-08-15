import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "../api";

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

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>(loadNotifications);
  // Tracks which rebuild jobs have already produced a notification, kept
  // separate from `notifications` itself so clearing the list doesn't cause
  // an already-seen completion to resurface on the next poll.
  const seenJobs = useRef<Set<string>>(loadSeenJobs());

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

  // Poll rebuild jobs so completions surface here (and as a toast) even if
  // the user has navigated away from Settings since starting one.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.channels.rebuildJobs();
        if (cancelled) return;
        for (const job of res.jobs) {
          if (job.status === "running" || seenJobs.current.has(job.id)) continue;
          seenJobs.current.add(job.id);
          localStorage.setItem(SEEN_JOBS_KEY, JSON.stringify([...seenJobs.current].slice(-200)));
          if (job.status === "done") {
            addNotification({ id: job.id, kind: "success", title: "Rebuild complete", message: `"${job.channelName}" finished rebuilding.` });
            pushToast(`Rebuild complete for "${job.channelName}"`, "success");
          } else {
            addNotification({
              id: job.id,
              kind: "error",
              title: "Rebuild failed",
              message: `"${job.channelName}": ${job.error || "unknown error"}`,
            });
            pushToast(`Rebuild failed for "${job.channelName}"`, "error");
          }
        }
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
  }, [addNotification, pushToast]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{ toasts, pushToast, dismissToast, notifications, unreadCount, markAllRead, dismissNotification, clearAllNotifications }}
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
