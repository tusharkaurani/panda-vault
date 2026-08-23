import { ComponentType, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, Download, FolderTree, Pencil, Trash2, TriangleAlert, Upload } from "lucide-react";
import { api, ApiError } from "../../api";
import type { Collection, SourceType } from "../../types";
import { collectionsBySource } from "../../lib/collections";
import EmptyState from "../../components/EmptyState";
import ErrorBanner from "../../components/ErrorBanner";
import Breadcrumbs from "../../components/Breadcrumbs";
import IntegrationIcon from "../../components/IntegrationIcon";
import IntegrationNameForm from "../../components/IntegrationNameForm";
import Tooltip from "../../components/Tooltip";
import TelegramPanel from "../../components/integrations/TelegramPanel";
import M3uPanel from "../../components/integrations/M3uPanel";
import type { IntegrationPanelProps } from "../../components/integrations/panel";
import { useIntegrations } from "../../integrations/IntegrationsContext";
import { useNotifications } from "../../notifications/NotificationContext";

/** One settings body per source type. Adding an integration means a `CATALOG`
 *  entry in `integrations.py`, an icon in `IntegrationIcon`, and an entry
 *  here — everything else keys off `sourceType`. A type with no panel yet
 *  still gets a page, it just has nothing to configure on it. */
const PANELS: Partial<Record<SourceType, ComponentType<IntegrationPanelProps>>> = {
  telegram: TelegramPanel,
  m3u: M3uPanel,
};

/** An integration's own page, reached from the list in Settings. Each
 *  integration used to be an accordion on that list, which meant every source
 *  type's settings competed for the same screen. */
export default function IntegrationSettings() {
  const { sourceType } = useParams<{ sourceType: string }>();
  const navigate = useNavigate();
  const integrations = useIntegrations();
  const { pushToast } = useNotifications();
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const entry = integrations.catalog.find((i) => i.id === sourceType);

  async function loadCollections() {
    try {
      setCollections(await api.collections.tree());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load collections");
    }
  }

  useEffect(() => {
    loadCollections();
  }, []);

  const sourceCollections = useMemo(
    () => (collections ? collectionsBySource(collections) : null),
    [collections]
  );

  function onChanged() {
    loadCollections();
    integrations.refresh();
  }

  async function rename(name: string) {
    if (!entry) return;
    setSavingName(true);
    try {
      await api.integrations.rename(entry.id, name);
      await integrations.refresh();
      setRenaming(false);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to rename integration", "error");
    } finally {
      setSavingName(false);
    }
  }

  async function remove() {
    if (!entry) return;
    if (!confirm(`Remove the ${entry.name} integration?`)) return;
    setRemoving(true);
    try {
      await api.integrations.remove(entry.id);
      await integrations.refresh();
      navigate("/settings/integrations");
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to remove integration", "error");
      setRemoving(false);
    }
  }

  async function exportConfig() {
    if (!entry) return;
    setExporting(true);
    try {
      const data = await api.integrations.export(entry.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `panda-vault-${entry.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to export configuration", "error");
    } finally {
      setExporting(false);
    }
  }

  async function importConfig(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again after a failure
    if (!file || !entry) return;
    setImporting(true);
    try {
      const data = JSON.parse(await file.text());
      const result = await api.integrations.import(entry.id, data);
      pushToast(
        `Imported ${result.sourcesAdded} source(s) and ${result.collectionsAdded} collection(s)`,
        "info"
      );
      onChanged();
    } catch (e) {
      pushToast(
        e instanceof ApiError ? e.message : "Failed to import — check the file is a Panda Vault export",
        "error"
      );
    } finally {
      setImporting(false);
    }
  }

  const breadcrumb = (
    <Breadcrumbs
      items={[
        { label: "Settings" },
        { label: "Integrations", to: "/settings/integrations" },
        { label: entry?.name ?? sourceType ?? "" },
      ]}
    />
  );

  // The catalog arrives async, so "not in it" only means anything once loaded.
  if (!entry || !entry.added) {
    if (integrations.loading) return breadcrumb;
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb}
        <EmptyState
          title={entry ? `${entry.name} isn't added` : `Unknown integration "${sourceType}"`}
          hint="Add it from the Integrations list to configure it."
          action={
            <Link
              to="/settings/integrations"
              className="mt-2 inline-flex items-center gap-2 rounded-lg bg-panda-accent text-panda-bg px-4 py-2 text-sm font-medium hover:opacity-90"
            >
              <ArrowLeft size={16} /> Back to Settings
            </Link>
          }
        />
      </div>
    );
  }

  const Panel = PANELS[entry.id];

  return (
    <div className="flex flex-col gap-6">
      {breadcrumb}

      <div className="flex items-start gap-3 flex-wrap">
        <IntegrationIcon id={entry.id} size={28} className="text-panda-accent shrink-0 mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold">{entry.name}</h1>
            <Tooltip label="Rename this integration's root folder in the Library">
              <button
                onClick={() => setRenaming((v) => !v)}
                className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2"
              >
                <Pencil size={14} />
              </button>
            </Tooltip>
            {/* Say what kind of thing this is once the name no longer does. */}
            {entry.name !== entry.defaultName && (
              <span className="text-xs text-panda-muted">{entry.defaultName}</span>
            )}
          </div>
          <p className="text-panda-muted text-sm mt-1">{entry.description}</p>
          <div className="flex items-center gap-3 flex-wrap mt-2">
            {entry.needsSetup ? (
              <span className="flex items-center gap-1 text-xs text-amber-400">
                <TriangleAlert size={12} /> {entry.configured ? "Not signed in" : "Not configured"}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <Check size={12} /> Ready
              </span>
            )}
            <span className="text-xs text-panda-muted">
              {entry.sourceCount.toLocaleString()} source{entry.sourceCount === 1 ? "" : "s"}
            </span>
            <Link
              to={`/settings/collections?type=${entry.id}`}
              className="flex items-center gap-1 text-xs text-panda-muted hover:text-panda-accent"
            >
              <FolderTree size={12} /> Collections
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip label={`Download ${entry.name}'s channels/playlists and collections as a JSON file`}>
            <button
              onClick={exportConfig}
              disabled={exporting}
              className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
            >
              <Download size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Import a configuration file exported from this or another vault">
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              className="p-1.5 rounded-md text-panda-muted hover:text-panda-accent hover:bg-panda-surface2 disabled:opacity-50"
            >
              <Upload size={16} />
            </button>
          </Tooltip>
          <input ref={importInputRef} type="file" accept="application/json" onChange={importConfig} className="hidden" />
          <Tooltip label={`Remove the ${entry.name} integration`}>
            <button
              onClick={remove}
              disabled={removing}
              className="p-1.5 rounded-md text-panda-muted hover:text-red-400 hover:bg-panda-surface2 disabled:opacity-50"
            >
              <Trash2 size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      {renaming && (
        <IntegrationNameForm
          integration={entry}
          submitLabel="Save name"
          busy={savingName}
          onSubmit={rename}
          onCancel={() => setRenaming(false)}
        />
      )}

      {error && <ErrorBanner message={error} />}

      {Panel ? (
        <Panel integration={entry} sourceCollections={sourceCollections} onChanged={onChanged} />
      ) : (
        <EmptyState
          title="Nothing to configure"
          hint="This build has no settings panel for this integration yet."
        />
      )}
    </div>
  );
}
