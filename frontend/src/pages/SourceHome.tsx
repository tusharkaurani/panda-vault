import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";
import { api, ApiError } from "../api";
import type { Collection, SourceType } from "../types";
import BackToTop from "../components/BackToTop";
import CollectionGrid from "../components/CollectionGrid";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";

const LABELS: Record<SourceType, string> = { telegram: "Telegram", m3u: "M3U" };
const NOUN: Record<SourceType, string> = { telegram: "channel", m3u: "playlist" };

function isSourceType(value: string): value is SourceType {
  return value === "telegram" || value === "m3u";
}

/** One integration's slice of the Library: the root collections the user
 *  defined for it. Kept separate from the Library page so a grid only ever
 *  holds one tree — sibling order is per-integration, and a drag that spanned
 *  two of them could not be persisted. */
export default function SourceHome() {
  const { sourceType = "" } = useParams();
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSourceType(sourceType)) return;
    api.collections
      .tree(sourceType)
      .then(setCollections)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load collections"));
  }, [sourceType]);

  if (!isSourceType(sourceType)) {
    return <ErrorBanner message={`Unknown integration "${sourceType}".`} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-1 text-sm text-panda-muted flex-wrap">
        <Link to="/" className="flex items-center gap-1 hover:text-panda-accent">
          <Home size={14} /> Library
        </Link>
        <span className="flex items-center gap-1">
          <ChevronRight size={14} />
          <span className="text-panda-text font-medium">{LABELS[sourceType]}</span>
        </span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold">{LABELS[sourceType]}</h1>
      </div>

      {error && <ErrorBanner message={error} />}

      {collections && collections.length === 0 && (
        <EmptyState
          title="No collections yet"
          hint={`Create a ${LABELS[sourceType]} collection in Settings and bind it to a ${NOUN[sourceType]}.`}
        />
      )}

      {collections && collections.length > 0 && (
        <CollectionGrid collections={collections} parentId={null} />
      )}

      <BackToTop />
    </div>
  );
}
