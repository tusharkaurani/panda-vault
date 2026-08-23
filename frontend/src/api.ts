import type {
  Channel,
  Collection,
  DocumentsResponse,
  GroupsResponse,
  HealthTotals,
  Integration,
  IntegrationExport,
  IntegrationStatus,
  KeywordCount,
  Playlist,
  RebuildJob,
  SearchResponse,
  SourceType,
  StreamHealthProfile,
  StreamHealthStatus,
} from "./types";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.detail || "";
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail || res.statusText || `Request failed (HTTP ${res.status})`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

export { ApiError };

export const api = {
  auth: {
    status: () => request<IntegrationStatus>("/auth/status"),
    sendCode: (phone: string) => request<{ sent: boolean }>("/auth/send-code", { method: "POST", body: JSON.stringify({ phone }) }),
    signIn: (code: string) => request<{ authorized: boolean; needsPassword?: boolean }>("/auth/sign-in", { method: "POST", body: JSON.stringify({ code }) }),
    signInPassword: (password: string) => request<{ authorized: boolean }>("/auth/sign-in-password", { method: "POST", body: JSON.stringify({ password }) }),
    qrLoginStart: () => request<{ url: string; expires: number }>("/auth/qr-login/start", { method: "POST" }),
    qrLoginPoll: () =>
      request<{ status: "pending" | "authorized" | "needs_password" | "expired" | "error"; error?: string }>("/auth/qr-login/poll"),
  },
  channels: {
    list: () => request<Channel[]>("/channels"),
    create: (body: { name: string; description: string; channel: string; allowedExtensions: string[] }) =>
      request<Channel>("/channels", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: Partial<{ name: string; description: string; channel: string; allowedExtensions: string[] }>) =>
      request<Channel>(`/channels/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: string, force = false) =>
      request<void>(`/channels/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }),
    join: (id: string) => request<{ joined: boolean }>(`/channels/${id}/join`, { method: "POST" }),
    rebuild: (id: string) => request<{ rebuilding: boolean; jobId: string }>(`/channels/${id}/rebuild`, { method: "POST" }),
    status: (id: string) => request<{ joined: boolean }>(`/channels/${id}/status`),
  },
  jobs: {
    // Spans every source type — scans of channels and playlists alike.
    list: () => request<{ jobs: RebuildJob[] }>("/jobs"),
  },
  integrations: {
    list: () => request<{ integrations: Integration[] }>("/integrations"),
    // `name` labels the integration's root node in the Library; omitted (or
    // blank) means the catalog default.
    add: (id: SourceType, name?: string) =>
      request<Integration>(`/integrations/${id}`, { method: "POST", body: JSON.stringify({ name: name ?? null }) }),
    rename: (id: SourceType, name: string) =>
      request<Integration>(`/integrations/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    remove: (id: SourceType) => request<void>(`/integrations/${id}`, { method: "DELETE" }),
    // The sources and collection tree Settings shows for this integration —
    // never the document cache, which the destination vault scans for itself.
    export: (id: SourceType) => request<IntegrationExport>(`/integrations/${id}/export`),
    import: (id: SourceType, data: IntegrationExport) =>
      request<{ sourcesAdded: number; collectionsAdded: number }>(`/integrations/${id}/import`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },
  playlists: {
    list: () => request<Playlist[]>("/playlists"),
    create: (body: {
      name: string;
      description: string;
      url: string;
      allowedExtensions: string[];
      refreshMinutes?: number | null;
    }) => request<Playlist>("/playlists", { method: "POST", body: JSON.stringify(body) }),
    update: (
      id: string,
      body: Partial<{
        name: string;
        description: string;
        url: string;
        allowedExtensions: string[];
        refreshMinutes: number | null;
      }>
    ) => request<Playlist>(`/playlists/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: string, force = false) =>
      request<void>(`/playlists/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }),
    /** `force` accepts a snapshot the server's shrink guard refused — only
     *  ever from an explicit user decision, never automatically. */
    rescan: (id: string, force = false) =>
      request<{ rebuilding: boolean; jobId: string }>(
        `/playlists/${id}/rescan${force ? "?force=true" : ""}`,
        { method: "POST" }
      ),
    /** What stream checking knows, and what running one now would cost. */
    streamHealth: () => request<StreamHealthStatus>("/playlists/health"),
    /** The exact shape of the work a check would do, computed from the
     *  cache — it makes no network requests of its own. */
    streamHealthProfile: () => request<StreamHealthProfile>("/playlists/health/profile"),
    /** Probe stream URLs now. Omit `id` for every playlist at once. Rejects
     *  with 409 if a check is already running — only one at a time, so a
     *  provider never sees two sweeps' worth of traffic. */
    checkStreams: (id?: string) =>
      request<{ checking: boolean; jobId: string }>(
        id ? `/playlists/${id}/health/scan` : "/playlists/health/scan",
        { method: "POST" }
      ),
  },
  collections: {
    tree: (sourceType?: SourceType) =>
      request<Collection[]>(`/collections/tree${sourceType ? `?sourceType=${sourceType}` : ""}`),
    // `sourceType` is required at the root and rejected when it disagrees
    // with the parent — a tree belongs to exactly one integration.
    create: (body: {
      name: string;
      description: string;
      icon?: string;
      sourceIds?: string[];
      parentId?: string | null;
      sourceType?: SourceType;
    }) => request<Collection>("/collections", { method: "POST", body: JSON.stringify(body) }),
    update: (
      id: string,
      body: Partial<{ name: string; description: string; icon: string; sourceIds: string[] }>
    ) => request<Collection>(`/collections/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: string) => request<void>(`/collections/${id}`, { method: "DELETE" }),
    move: (id: string, parentId: string | null) =>
      request<Collection>(`/collections/${id}/move`, { method: "POST", body: JSON.stringify({ parentId }) }),
    // orderedIds must cover that level completely — the server rejects a
    // partial order (409) rather than dropping the collections left out.
    // At the root that level is per-integration, so `sourceType` says which
    // tree's roots are being ordered; the others keep their own order.
    reorder: (parentId: string | null, orderedIds: string[], sourceType?: SourceType) =>
      request<void>("/collections/reorder", {
        method: "POST",
        body: JSON.stringify({ parentId, orderedIds, sourceType }),
      }),
    /** Reachability tallies alone — cheap enough to poll while a stream
     *  check runs, unlike the documents endpoint. */
    health: (id: string) => request<{ healthTotals: HealthTotals }>(`/collections/${id}/health`),
    documents: (
      id: string,
      opts: {
        search?: string;
        sort?: string;
        refresh?: boolean;
        offset?: number;
        limit?: number;
        health?: string;
        /** One category out of a (possibly `;`-joined) group_title. `""`
         *  asks for the untagged bucket — distinct from omitting the field,
         *  which applies no group filter at all. */
        group?: string;
      } = {}
    ) => {
      const params = new URLSearchParams();
      if (opts.search) params.set("search", opts.search);
      if (opts.sort) params.set("sort", opts.sort);
      if (opts.refresh) params.set("refresh", "true");
      if (opts.health) params.set("health", opts.health);
      if (opts.offset) params.set("offset", String(opts.offset));
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.group !== undefined) params.set("group", opts.group);
      const qs = params.toString();
      return request<DocumentsResponse>(`/collections/${id}/documents${qs ? `?${qs}` : ""}`);
    },
    /** The Grouped view's overview — one category per card, with a real
     *  count computed server-side rather than from whatever page of
     *  documents happens to be loaded. */
    groups: (id: string, opts: { search?: string; refresh?: boolean; health?: string } = {}) => {
      const params = new URLSearchParams();
      if (opts.search) params.set("search", opts.search);
      if (opts.refresh) params.set("refresh", "true");
      if (opts.health) params.set("health", opts.health);
      const qs = params.toString();
      return request<GroupsResponse>(`/collections/${id}/groups${qs ? `?${qs}` : ""}`);
    },
    keywords: (id: string, limit = 8) =>
      request<{ keywords: KeywordCount[] }>(`/collections/${id}/keywords?limit=${limit}`),
  },
  search: (q: string, opts: { offset?: number; limit?: number; signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.offset) params.set("offset", String(opts.offset));
    if (opts.limit) params.set("limit", String(opts.limit));
    // Note: an aborted request rejects with a DOMException named
    // "AbortError", not an ApiError — callers must let that one through.
    return request<SearchResponse>(`/search?${params}`, { signal: opts.signal });
  },
  // Telegram only: an M3U entry is a stream URL, not a download.
  downloadUrl: (channelId: string, msgId: number) => `/api/download/${channelId}/${msgId}`,
};
