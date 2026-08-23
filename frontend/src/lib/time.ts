/** Relative timestamps, in the two units this app deals in.
 *
 *  Notifications are stamped in the browser with Date.now() (milliseconds),
 *  while anything that came from the API was stamped by Python's time.time()
 *  (seconds). Mixing them silently reports "56y ago", so each unit gets its
 *  own named entry point rather than a single ambiguous one.
 */
export function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** For a Unix timestamp in seconds, as every API field carries. */
export function timeAgoUnix(seconds: number): string {
  return timeAgo(seconds * 1000);
}
