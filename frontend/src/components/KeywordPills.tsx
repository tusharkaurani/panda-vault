import { useEffect, useState } from "react";
import { api } from "../api";
import type { KeywordCount } from "../types";

/** Pill row of the most-frequent words in this collection's cached
 * filenames — shown under the search bar so users can jump straight to a
 * publication/topic without typing. Clicking a pill runs it as a search. */
export default function KeywordPills({
  collectionId,
  onSelect,
}: {
  collectionId: string;
  onSelect: (word: string) => void;
}) {
  const [keywords, setKeywords] = useState<KeywordCount[]>([]);

  useEffect(() => {
    let cancelled = false;
    setKeywords([]);
    api.collections
      .keywords(collectionId)
      .then((res) => {
        if (!cancelled) setKeywords(res.keywords);
      })
      .catch(() => {
        /* pills are a nice-to-have — fail silently */
      });
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  if (keywords.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {keywords.map((k) => (
        <button
          key={k.word}
          type="button"
          onClick={() => onSelect(k.word)}
          title={`${k.count} matching file${k.count === 1 ? "" : "s"}`}
          className="rounded-full border border-panda-border bg-panda-surface px-2.5 py-1 text-xs text-panda-muted capitalize hover:border-panda-accent hover:text-panda-text transition-colors"
        >
          {k.word}
        </button>
      ))}
    </div>
  );
}
