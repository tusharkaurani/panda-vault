import { useState } from "react";
import { Check, Copy } from "lucide-react";
import Tooltip from "./Tooltip";

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
    <Tooltip label={copied ? "Link copied" : "Copy Telegram link"}>
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
      >
        {copied ? <Check size={size} /> : <Copy size={size} />}
      </button>
    </Tooltip>
  );
}
