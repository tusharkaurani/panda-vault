import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Home, Settings as SettingsIcon } from "lucide-react";
import { api, ApiError } from "../api";
import type { Collection } from "../types";
import CollectionCard from "../components/CollectionCard";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";

export default function Landing() {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.collections
      .tree()
      .then(setCollections)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load collections"));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-1 text-sm text-panda-muted flex-wrap">
        <span className="flex items-center gap-1 text-panda-text font-medium">
          <Home size={14} /> Library
        </span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold">Library</h1>
        <p className="text-panda-muted text-sm mt-1">Browse your Telegram channels, organized into collections.</p>
      </div>

      {error && <ErrorBanner message={error} />}

      {collections && collections.length === 0 && (
        <EmptyState
          title="No collections yet"
          hint="Add a Telegram channel and create a collection for it in Settings to get started."
          action={
            <Link
              to="/settings"
              className="mt-2 inline-flex items-center gap-2 rounded-lg bg-panda-accent text-panda-bg px-4 py-2 text-sm font-medium hover:opacity-90"
            >
              <SettingsIcon size={16} /> Go to Settings
            </Link>
          }
        />
      )}

      {collections && collections.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {collections.map((c) => (
            <CollectionCard key={c.id} collection={c} />
          ))}
        </div>
      )}
    </div>
  );
}
