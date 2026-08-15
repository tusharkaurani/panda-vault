import { AlertTriangle } from "lucide-react";

export default function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/40 text-red-200 px-4 py-3 text-sm">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
