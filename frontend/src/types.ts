/** The kinds of integration a collection tree can be built from. Telegram
 *  channels and M3U playlists are both "sources": they share an id space
 *  and behave the same everywhere except where noted. */
export type SourceType = "telegram" | "m3u";

export type ChannelStatus =
  | "ready"
  | "scanning"
  | "rebuilding"
  | "unscanned"
  | "empty"
  | "error"
  | "not_joined";

/** States only a fetched-by-URL source can be in. `stale` and `invalid`
 *  both mean the cached entries are still browsable but no longer being
 *  updated; `needs_review` means the newest snapshot was refused for being
 *  drastically smaller than the one it would have replaced. */
export type PlaylistStatus = "stale" | "invalid" | "needs_review";

/** A playlist is never `not_joined` — there is nothing to join. */
export type SourceStatus = ChannelStatus | PlaylistStatus;

export interface Channel {
  id: string;
  name: string;
  description: string;
  channel: string;
  joined: boolean;
  allowedExtensions: string[];
  created_at: number;
  // Computed server-side from the document cache + any in-flight scan.
  fileCount: number;
  status: ChannelStatus;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  /** How this playlist's entries were sourced. "upload" means `url` is
   *  empty and the entries came from a file the user uploaded — there is
   *  nothing to periodically re-fetch, only a replacement upload. */
  source: "url" | "upload";
  /** Remote .m3u / .m3u8 URL, exactly as entered. Empty when source is "upload". */
  url: string;
  /** The uploaded file's original name, for display. Set only when source is "upload". */
  originalFilename: string | null;
  /** Matched against the *stream* URL's extension, not the entry's name. */
  allowedExtensions: string[];
  /** How often to re-fetch, in minutes. null = the server's default. */
  refreshMinutes: number | null;
  created_at: number;
  fileCount: number;
  status: SourceStatus;
  /** How the last fetch that reached the network went. null = never tried. */
  fetchStatus: "ok" | "failed" | "invalid" | "shrunk" | null;
  fetchError: string | null;
  /** Unix seconds of the last fetch that actually worked. */
  lastOkAt: number | null;
  /** Consecutive failures — 1 is treated as a blip. */
  failStreak: number;
}

/** Whichever kind of thing a collection is bound to. */
export type Source = Channel | Playlist;

export function isPlaylist(source: Source): source is Playlist {
  return "url" in source;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  icon?: string | null;
  /** Set at creation and inherited by every descendant: a tree belongs to
   *  exactly one integration. */
  sourceType: SourceType;
  /** Channel ids or playlist ids, according to `sourceType`. Non-empty
   *  means this is a leaf; `children` non-empty means it is a container. */
  sourceIds: string[];
  children: Collection[];
  fileCount?: number;
  folderCount?: number;
}

export interface DocumentOut {
  /** A Telegram message id, or an M3U entry's ordinal within its playlist
   *  snapshot — renumbered by every rescan, so never persist it. */
  id: number;
  name: string;
  /** 0 for stream entries: a stream has no length to report. */
  size: number;
  size_human: string;
  date: string;
  mime_type?: string | null;
  sourceId?: string | null;
  sourceType: SourceType;
  /** m3u only, null for anything with no URL to probe. Joined in from the
   *  URL-keyed health table, so it survives the nightly snapshot swap that
   *  renumbers every entry. */
  health: StreamHealth | null;
  healthCheckedAt: number | null;
  // m3u only, null for Telegram documents.
  url?: string | null;
  logo?: string | null;
  group?: string | null;
}

/** Whether a stream URL answered when it was last probed. `unchecked` means
 *  no probe has happened yet, which reads differently from one that came
 *  back unreachable. Telegram documents have no URL and so carry null. */
export type StreamHealth = "available" | "unavailable" | "unknown" | "unchecked";

/** Entry counts per reachability state — entries, not distinct URLs, since a
 *  stream listed in three playlists is three things you can click. */
export type HealthTotals = Partial<Record<StreamHealth, number>>;

export interface DocumentsResponse {
  collection: Collection;
  sources: Source[];
  documents: DocumentOut[];
  total: number;
  offset: number;
  limit: number;
  errors?: string[];
  /** Empty for Telegram collections — only streams have a health state. */
  healthTotals?: HealthTotals;
}

/** One category card in the Grouped view's overview. `name` is `""` for the
 *  "Other channels" bucket — untagged entries, not "no filter". */
export interface GroupSummary {
  name: string;
  count: number;
}

export interface GroupsResponse {
  collection: Collection;
  sources: Source[];
  groups: GroupSummary[];
  errors?: string[];
  healthTotals?: HealthTotals;
}

/** GET /api/playlists/health/profile — exactly what a check would do,
 *  worked out from the cache without making a single request. The range on
 *  `requests` is real uncertainty: the floor assumes every triaged provider
 *  is down (so none of its URLs need probing individually), the ceiling that
 *  they are all up. Which it is, is the thing the check exists to find out. */
export interface StreamHealthProfile {
  /** Total stream entries across every playlist. */
  entries: number;
  /** Distinct URLs actually due a probe. */
  dueUrls: number;
  /** Entries skipped because another playlist lists the same URL. */
  deduped: number;
  hosts: number;
  /** Hosts big enough that one connect can settle them wholesale. */
  triageHosts: number;
  triageUrls: number;
  singleUrlHosts: number;
  requests: { min: number; max: number };
  minutes: { min: number; max: number };
  approxMegabytes: number;
}

/** GET /api/playlists/health — the state of stream checking vault-wide. */
export interface StreamHealthStatus {
  running: boolean;
  lastSweepAt: number | null;
  /** Distinct URLs a check would probe right now. */
  due: number;
  estimatedMinutes: number;
  totals: HealthTotals;
  /** Playlists queued or actively being checked right now. */
  queued: number;
}

// Deliberately flat: this used to carry the whole `Collection` (recursively,
// children and all) plus the whole `Channel` for every single result, which
// is what made an unpaginated search response reach tens of megabytes.
export interface SearchResult {
  collectionId: string;
  collectionName: string;
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  document: DocumentOut;
}

export interface SearchResponse {
  query: string;
  total: number;
  offset: number;
  limit: number;
  results: SearchResult[];
}

export interface KeywordCount {
  word: string;
  count: number;
}

export interface RebuildJob {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  kind: "scan" | "rebuild" | "health";
  status: "queued" | "running" | "done" | "error";
  scanned: number;
  total: number | null;
  startedAt: number;
  finishedAt: number | null;
  error?: string | null;
  /** Routine housekeeping (the nightly stream sweep) — tracked here for
   *  per-playlist progress, but shouldn't produce a notification-bell toast
   *  the way a user-triggered job does. */
  silent?: boolean;
}

/** One entry in the integration catalog: what this build can connect, and
 *  what this vault has actually added. */
export interface Integration {
  id: SourceType;
  /** What this integration's root node is called in the Library — the user's
   *  label once they've set one, `defaultName` until then. */
  name: string;
  /** The catalog's own name for the type, e.g. "M3U Playlists". Survives a
   *  rename, so the UI can offer it as a placeholder and still say what kind
   *  of thing this is. */
  defaultName: string;
  description: string;
  /** Whether it needs credentials before it can be signed into at all. */
  needsCredentials: boolean;
  /** Added to this vault — it gets a tab, and a node in the Library even
   *  while it is still empty. */
  added: boolean;
  /** Credentials present (always true for integrations that need none). */
  configured: boolean;
  /** Usable right now. */
  connected: boolean;
  sourceCount: number;
  /** Added but not yet usable — the UI leads with this. */
  needsSetup: boolean;
}

/** One source inside an IntegrationExport. `id` is a reference local to the
 *  export file, only used to reattach a CollectionExport's `sourceIds` — it
 *  has no relation to any id in a vault that imports it. */
export interface SourceExport {
  id: string;
  name: string;
  description: string;
  channel?: string | null; // telegram only
  url?: string | null; // m3u only
  allowedExtensions: string[];
  refreshMinutes?: number | null; // m3u only
}

export interface CollectionExport {
  name: string;
  description: string;
  icon?: string | null;
  sourceIds: string[];
  children: CollectionExport[];
}

/** The download/upload shape of GET/POST /api/integrations/:id/export|import
 *  — just what Settings shows for this integration, never the document
 *  cache. */
export interface IntegrationExport {
  sourceType: SourceType;
  integrationName?: string | null;
  sources: SourceExport[];
  collections: CollectionExport[];
}

export interface IntegrationStatus {
  /** Whether TG_API_ID / TG_API_HASH were supplied at all. Without them
   *  there is nothing to log in to, so the UI shows setup instructions
   *  rather than a login form. */
  configured: boolean;
  authorized: boolean;
}
