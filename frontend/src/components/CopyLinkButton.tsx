import { useState } from "react";
import { Check, Copy } from "lucide-react";

export default function CopyLinkButton({
  url,
  size = 14,
  className = "text-panda-muted hover:text-panda-accent",
}: {
  url: string;
  size?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={className}
      title="Copy Telegram link"
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
