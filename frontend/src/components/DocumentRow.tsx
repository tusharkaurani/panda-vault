import { File, FileArchive, FileText, FileImage, FileVideo, FileAudio, Download } from "lucide-react";
import type { DocumentOut } from "../types";
import { api } from "../api";

function iconFor(mime?: string | null, name?: string) {
  const m = mime || "";
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  if (m.startsWith("image/")) return FileImage;
  if (m.startsWith("video/")) return FileVideo;
  if (m.startsWith("audio/")) return FileAudio;
  if (m.includes("pdf") || ["doc", "docx", "txt", "epub"].includes(ext)) return FileText;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return FileArchive;
  return File;
}

export default function DocumentRow({ doc, channelName }: { doc: DocumentOut; channelName?: string }) {
  const Icon = iconFor(doc.mime_type, doc.name);
  return (
    <a
      href={api.downloadUrl(doc.channelId!, doc.id)}
      className="group flex items-center gap-3 rounded-lg border border-panda-border bg-panda-surface px-4 py-3 hover:border-panda-accent transition-colors"
    >
      <Icon className="text-panda-muted shrink-0" size={20} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{doc.name}</p>
        <p className="text-xs text-panda-muted">
          {doc.size_human} · {new Date(doc.date).toLocaleString()}
          {channelName && <> · {channelName}</>}
        </p>
      </div>
      <Download className="text-panda-muted group-hover:text-panda-accent shrink-0" size={18} />
    </a>
  );
}
