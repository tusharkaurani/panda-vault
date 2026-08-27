/** The extension a stream URL ends in — the same thing a playlist's
 *  allowedExtensions filters on. */
export function streamExt(url?: string | null): string | null {
  if (!url) return null;
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop() || "";
  if (!last.includes(".")) return null;
  return last.split(".").pop()!.toLowerCase().slice(0, 6);
}

/** Extensions StreamPlayerModal plays via hls.js / Safari's native HLS
 *  support. Everything else falls back to an iframe and the browser's own
 *  native player instead. */
const HLS_EXTENSIONS = new Set(["m3u8", "m3u"]);

export function isHlsStream(url?: string | null): boolean {
  const ext = streamExt(url);
  return !!ext && HLS_EXTENSIONS.has(ext);
}
