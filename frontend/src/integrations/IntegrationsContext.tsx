import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Integration, SourceType } from "../types";

interface Integrations {
  /** The whole catalog — added and not — so the UI can offer what's left. */
  catalog: Integration[];
  /** Just the ones this vault has added, in catalog order. These get a tab
   *  and a Library node, even while empty. */
  added: Integration[];
  byId: (id: SourceType) => Integration | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
}

// Exported so a render harness can supply a populated catalog without a
// network round trip — the states worth checking (several integrations, one
// needing setup) only exist after a fetch that server rendering never runs.
export const IntegrationsContext = createContext<Integrations | null>(null);
const Ctx = IntegrationsContext;

export function IntegrationsProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.integrations.list();
      setCatalog(res.integrations);
    } catch {
      // An unreachable backend shouldn't leave the app in a half-rendered
      // state — an empty catalog renders as "nothing connected yet".
      setCatalog([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<Integrations>(
    () => ({
      catalog,
      added: catalog.filter((i) => i.added),
      byId: (id) => catalog.find((i) => i.id === id),
      loading,
      refresh,
    }),
    [catalog, loading, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useIntegrations(): Integrations {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useIntegrations must be used inside an IntegrationsProvider");
  return ctx;
}
