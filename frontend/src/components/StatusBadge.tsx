export default function StatusBadge({ joined }: { joined: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        joined ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${joined ? "bg-emerald-400" : "bg-amber-400"}`} />
      {joined ? "Joined" : "Not joined"}
    </span>
  );
}
