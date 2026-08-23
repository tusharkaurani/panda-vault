import { ListVideo, Puzzle, Send } from "lucide-react";

// One icon per integration id. Puzzle is the fallback for a source type the
// backend knows about before the frontend has an icon for it — adding an
// integration shouldn't be able to break a page that hasn't caught up.
const ICONS: Record<string, typeof Send> = {
  telegram: Send,
  m3u: ListVideo,
};

/** Renders an integration's icon.
 *
 *  A component rather than a lookup callers invoke themselves: lucide icons
 *  are `forwardRef` objects, so calling one as a plain function throws at
 *  runtime — and TypeScript does *not* catch it, because
 *  ForwardRefExoticComponent is typed as callable. Keeping the JSX in one
 *  place means that mistake can only be made once. */
export default function IntegrationIcon({
  id,
  size = 18,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  const Icon = ICONS[id] ?? Puzzle;
  return <Icon size={size} className={className} />;
}
