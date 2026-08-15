import { ReactNode } from "react";
import { Inbox } from "lucide-react";

export default function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-panda-muted">
      <Inbox size={40} strokeWidth={1.5} />
      <p className="font-medium text-panda-text">{title}</p>
      {hint && <p className="text-sm max-w-sm">{hint}</p>}
      {action}
    </div>
  );
}
