import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useNotifications } from "./NotificationContext";

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };
const COLORS = { success: "text-emerald-400", error: "text-red-400", info: "text-panda-accent" };

export default function ToastContainer() {
  const { toasts, dismissToast } = useNotifications();
  if (!toasts.length) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className="animate-toast-in flex items-start gap-2.5 rounded-xl border border-panda-border bg-panda-surface/95 backdrop-blur shadow-lg shadow-black/20 px-3.5 py-3 text-sm"
          >
            <Icon size={18} className={`shrink-0 mt-0.5 ${COLORS[t.kind]}`} />
            <span className="flex-1 text-panda-text leading-snug">{t.message}</span>
            <button onClick={() => dismissToast(t.id)} className="shrink-0 text-panda-muted hover:text-panda-text">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
