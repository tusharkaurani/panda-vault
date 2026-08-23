/** The single place an M3U entry's logo URL is resolved.
 *
 *  Playlists carry `tvg-logo` URLs pointing at whatever host the provider
 *  chose, and a great many of them are plain http. A page served over https
 *  silently drops http subresources as mixed content, so those logos would
 *  simply never appear — with no error a user could act on. Upgrading the
 *  scheme optimistically costs nothing: hosts that support https serve the
 *  image, and the rest fail the same way they would have anyway, landing on
 *  the caller's onError fallback.
 *
 *  This is also the seam for caching logos locally later: point it at a
 *  backend proxy endpoint and every logo in the app follows. */
export function logoSrc(raw?: string | null): string | null {
  const url = (raw ?? "").trim();
  if (!url) return null;
  if (typeof window !== "undefined" && window.location.protocol === "https:" && url.startsWith("http://")) {
    return `https://${url.slice("http://".length)}`;
  }
  return url;
}

/** Up to two letters for the placeholder tile shown when there's no logo, or
 *  when the one we were given fails to load. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/[\s\-_.|]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
