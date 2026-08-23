import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Home } from "lucide-react";
import { api, ApiError } from "../api";
import type { Collection, SourceType } from "../types";
import Breadcrumbs from "../components/Breadcrumbs";
import BackToTop from "../components/BackToTop";
import CollectionGrid from "../components/CollectionGrid";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import { useIntegrations } from "../integrations/IntegrationsContext";

// The *source* noun, not a display label: this one is fixed by the source
// type, where the heading above it is whatever the user named the root.
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
  const { byId } = useIntegrations();
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

  // Falls back to the id in the instant before the catalog arrives.
  const label = byId(sourceType)?.name ?? sourceType;

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: "Library", to: "/", icon: <Home size={14} /> },
          { label },
        ]}
      />

      <div>
        <h1 className="text-2xl font-semibold">{label}</h1>
      </div>

      {error && <ErrorBanner message={error} />}

      {collections && collections.length === 0 && (
        <EmptyState
          title="No collections yet"
          hint={`Create a ${label} collection in Settings and bind it to a ${NOUN[sourceType]}.`}
        />
      )}

      {collections && collections.length > 0 && (
        <CollectionGrid collections={collections} parentId={null} />
      )}

      <BackToTop />
    </div>
  );
}
