import { FileText } from "lucide-react";
import Tooltip from "./Tooltip";

/** The channel's cached file count, shown wherever a channel is named. It
 *  reflects the cache as of the last load, so during a scan it trails the
 *  live figure in the status pill until the next refetch. */
export default function FileCount({ count, size = 12 }: { count: number; size?: number }) {
  return (
    <Tooltip label={`${count.toLocaleString()} file(s) indexed from this channel`}>
      <span className="inline-flex items-center gap-1 text-xs text-panda-muted tabular-nums">
        <FileText size={size} />
        {count.toLocaleString()}
      </span>
    </Tooltip>
  );
}
