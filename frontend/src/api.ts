import type { Channel, Collection, DocumentsResponse, KeywordCount, RebuildJob, SearchResult } from "./types";

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
    status: () => request<{ authorized: boolean }>("/auth/status"),
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
    rebuildJobs: () => request<{ jobs: RebuildJob[] }>("/channels/rebuild-jobs"),
  },
  collections: {
    tree: () => request<Collection[]>("/collections/tree"),
    create: (body: { name: string; description: string; icon?: string; channelIds?: string[]; parentId?: string | null }) =>
      request<Collection>("/collections", { method: "POST", body: JSON.stringify(body) }),
    update: (
      id: string,
      body: Partial<{ name: string; description: string; icon: string; channelIds: string[] }>
    ) => request<Collection>(`/collections/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: string) => request<void>(`/collections/${id}`, { method: "DELETE" }),
    move: (id: string, parentId: string | null) =>
      request<Collection>(`/collections/${id}/move`, { method: "POST", body: JSON.stringify({ parentId }) }),
    documents: (
      id: string,
      opts: { search?: string; sort?: string; refresh?: boolean; offset?: number; limit?: number } = {}
    ) => {
      const params = new URLSearchParams();
      if (opts.search) params.set("search", opts.search);
      if (opts.sort) params.set("sort", opts.sort);
      if (opts.refresh) params.set("refresh", "true");
      if (opts.offset) params.set("offset", String(opts.offset));
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      return request<DocumentsResponse>(`/collections/${id}/documents${qs ? `?${qs}` : ""}`);
    },
    keywords: (id: string, limit = 8) =>
      request<{ keywords: KeywordCount[] }>(`/collections/${id}/keywords?limit=${limit}`),
  },
  search: (q: string) => request<{ query: string; results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`),
  downloadUrl: (channelId: string, msgId: number) => `/api/download/${channelId}/${msgId}`,
};
