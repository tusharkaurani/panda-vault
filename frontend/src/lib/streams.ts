/** The extension a stream URL ends in — the same thing a playlist's
 *  allowedExtensions filters on. */
export function streamExt(url?: string | null): string | null {
  if (!url) return null;
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop() || "";
  if (!last.includes(".")) return null;
  return last.split(".").pop()!.toLowerCase().slice(0, 6);
}

/** StreamPlayerModal only speaks HLS (native Safari playback or hls.js) — it
 *  has no path for a raw video file, so offering it for an .mp4/.ts/.mkv URL
 *  just opens a modal that fails every time. */
const HLS_EXTENSIONS = new Set(["m3u8", "m3u"]);

export function isPlayableStream(url?: string | null): boolean {
  const ext = streamExt(url);
  return !!url && !!ext && HLS_EXTENSIONS.has(ext);
}
