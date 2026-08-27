import { useEffect, useState } from "react";

const STORAGE_KEY = "panda-stream-health-filter";

/** The M3U reachability filter ("Working" / "Not working" / …). Defaults to
 *  "available" and, unlike search or sort, persists across collections and
 *  categories via localStorage until the user explicitly changes it — most
 *  users browsing playlists want dead streams hidden everywhere, not just in
 *  the collection where they last set the filter. */
export function useStreamHealthFilter() {
  const [health, setHealth] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? "available");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, health);
  }, [health]);

  return [health, setHealth] as const;
}
