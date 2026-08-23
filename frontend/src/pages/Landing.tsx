import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Home, Settings as SettingsIcon } from "lucide-react";
import { api, ApiError } from "../api";
import type { Collection, SourceType } from "../types";
import BackToTop from "../components/BackToTop";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import IntegrationIcon from "../components/IntegrationIcon";
import { useIntegrations } from "../integrations/IntegrationsContext";

/** The Library root is *virtual*: it isn't a stored collection, it's one node
 *  per connected integration, each opening that integration's own tree. An
 *  integration with nothing configured gets no node at all. */
export default function Landing() {
  const { added, loading } = useIntegrations();
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.collections
      .tree()
      .then(setCollections)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load collections"));
  }, []);

  function summary(type: SourceType) {
    const roots = (collections ?? []).filter((n) => n.sourceType === type);
    const files = roots.reduce((sum, n) => sum + (n.fileCount ?? 0), 0);
    return { roots: roots.length, files };
  }

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-1 text-sm text-panda-muted flex-wrap">
        <span className="flex items-center gap-1 text-panda-text font-medium">
          <Home size={14} /> Library
        </span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold">Library</h1>
        <p className="text-panda-muted text-sm mt-1">
          Everything you've connected, organized into collections.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      {!loading && added.length === 0 && (
        <EmptyState
          title="Nothing connected yet"
          hint="Add an integration in Settings to get started."
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

      {added.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {added.map((integration) => {
            const { roots, files } = summary(integration.id);
            return (
              <Link
                key={integration.id}
                to={`/s/${integration.id}`}
                className="group flex flex-col gap-2 rounded-lg border border-panda-border bg-panda-surface p-4 hover:border-panda-accent transition-colors"
              >
                <div className="flex items-center gap-2">
                  <IntegrationIcon id={integration.id} size={20} className="text-panda-accent shrink-0" />
                  <span className="font-medium group-hover:text-panda-accent transition-colors">
                    {integration.name}
                  </span>
                </div>
                {/* Added but not usable yet — say so here rather than let the
                    card read as an empty library. */}
                {integration.needsSetup ? (
                  <p className="text-xs text-amber-400">
                    {integration.configured ? "Not signed in" : "Not configured"} — finish setup in Settings
                  </p>
                ) : (
                  <p className="text-xs text-panda-muted">
                    {integration.sourceCount.toLocaleString()} source{integration.sourceCount === 1 ? "" : "s"}
                  </p>
                )}
                <p className="text-xs text-panda-muted mt-auto">
                  {roots.toLocaleString()} collection{roots === 1 ? "" : "s"} · {files.toLocaleString()} item
                  {files === 1 ? "" : "s"}
                </p>
              </Link>
            );
          })}
        </div>
      )}

      <BackToTop />
    </div>
  );
}
