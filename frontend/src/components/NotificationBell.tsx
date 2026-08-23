import { useEffect, useRef, useState } from "react";
import { AlertCircle, Bell, CheckCircle2, X } from "lucide-react";
import { useNotifications } from "../notifications/NotificationContext";
import { timeAgo } from "../lib/time";
import Tooltip from "./Tooltip";

export default function NotificationBell() {
  const { notifications, unreadCount, markAllRead, dismissNotification, clearAllNotifications } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function toggle() {
    setOpen((v) => {
      if (!v) markAllRead();
      return !v;
    });
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <Tooltip label={unreadCount > 0 ? `${unreadCount} unread notification(s)` : "Notifications"} side="bottom">
        <button
          onClick={toggle}
          className="relative p-2 rounded-lg border border-panda-border hover:border-panda-accent hover:text-panda-accent transition-colors"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-panda-border bg-panda-surface shadow-lg shadow-black/20 overflow-hidden z-20">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-panda-border">
            <span className="text-sm font-medium">Notifications</span>
            {notifications.length > 0 && (
              <Tooltip label="Clear all notifications" side="bottom">
                <button onClick={clearAllNotifications} className="text-xs text-panda-muted hover:text-panda-accent">
                  Clear all
                </button>
              </Tooltip>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-3.5 py-6 text-center text-sm text-panda-muted">No notifications yet.</p>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className="flex items-start gap-2.5 px-3.5 py-3 border-b border-panda-border last:border-0 hover:bg-panda-surface2"
                >
                  {n.kind === "success" ? (
                    <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-emerald-400" />
                  ) : (
                    <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-400" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{n.title}</p>
                    <p className="text-xs text-panda-muted mt-0.5">{n.message}</p>
                    <p className="text-[11px] text-panda-muted mt-1">{timeAgo(n.createdAt)}</p>
                  </div>
                  <Tooltip label="Dismiss" side="bottom">
                    <button onClick={() => dismissNotification(n.id)} className="shrink-0 text-panda-muted hover:text-panda-text">
                      <X size={14} />
                    </button>
                  </Tooltip>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
