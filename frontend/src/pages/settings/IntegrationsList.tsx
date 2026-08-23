import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight, TriangleAlert } from "lucide-react";
import { api, ApiError } from "../../api";
import type { SourceType } from "../../types";
import AddIntegrationMenu from "../../components/AddIntegrationMenu";
import EmptyState from "../../components/EmptyState";
import IntegrationNameForm from "../../components/IntegrationNameForm";
import IntegrationIcon from "../../components/IntegrationIcon";
import { useIntegrations } from "../../integrations/IntegrationsContext";
import { useNotifications } from "../../notifications/NotificationContext";

/** The Integrations tab: a registry and nothing more. Every added integration
 *  links out to its own page — the sources it provides are managed there, not
 *  here, so two source types' settings never share the screen. Fetches
 *  nothing: the catalog it renders already lives in the integrations context. */
export default function IntegrationsList() {
  const { pushToast } = useNotifications();
  const integrations = useIntegrations();
  const [busyIntegration, setBusyIntegration] = useState<string | null>(null);
  // Picking from the menu doesn't add straight away: it opens the name form,
  // so the root node the Library is about to grow gets named up front.
  const [pending, setPending] = useState<SourceType | null>(null);
  const pendingEntry = integrations.catalog.find((e) => e.id === pending);

  async function addIntegration(id: SourceType, name: string) {
    setBusyIntegration(id);
    try {
      await api.integrations.add(id, name);
      await integrations.refresh();
      setPending(null);
    } catch (e) {
      pushToast(e instanceof ApiError ? e.message : "Failed to add integration", "error");
    } finally {
      setBusyIntegration(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <p className="text-sm text-panda-muted">
          Everything this vault is connected to. Each one gets its own tree in the Library.
        </p>
        <AddIntegrationMenu catalog={integrations.catalog} busyId={busyIntegration} onAdd={setPending} />
      </div>

      {pendingEntry && (
        <IntegrationNameForm
          key={pendingEntry.id}
          integration={pendingEntry}
          submitLabel={`Add ${pendingEntry.defaultName}`}
          busy={busyIntegration === pendingEntry.id}
          onSubmit={(name) => addIntegration(pendingEntry.id, name)}
          onCancel={() => setPending(null)}
        />
      )}

      {!integrations.loading && integrations.added.length === 0 && !pendingEntry && (
        <EmptyState
          title="No integrations yet"
          hint="Add one to start filling your vault. M3U needs no account; Telegram needs a one-time sign-in."
        />
      )}

      <div className="flex flex-col gap-2">
        {integrations.added.map((entry) => (
          <Link
            key={entry.id}
            to={`/settings/integrations/${entry.id}`}
            className="group flex items-center gap-3 rounded-lg border border-panda-border bg-panda-surface px-4 py-3 hover:border-panda-accent transition-colors"
          >
            <IntegrationIcon id={entry.id} size={20} className="text-panda-accent shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium group-hover:text-panda-accent transition-colors">{entry.name}</span>
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
              </div>
              <p className="text-xs text-panda-muted mt-0.5 truncate">{entry.description}</p>
            </div>
            <ChevronRight size={18} className="text-panda-muted group-hover:text-panda-accent shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
