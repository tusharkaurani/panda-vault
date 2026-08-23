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

/** A playlist is never `not_joined` — there is nothing to join. */
export type SourceStatus = ChannelStatus;

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
  /** Remote .m3u / .m3u8 URL, exactly as entered. */
  url: string;
  /** Matched against the *stream* URL's extension, not the entry's name. */
  allowedExtensions: string[];
  created_at: number;
  fileCount: number;
  status: SourceStatus;
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
  // m3u only, null for Telegram documents.
  url?: string | null;
  logo?: string | null;
  group?: string | null;
}

export interface DocumentsResponse {
  collection: Collection;
  sources: Source[];
  documents: DocumentOut[];
  total: number;
  offset: number;
  limit: number;
  errors?: string[];
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
  kind: "scan" | "rebuild";
  status: "running" | "done" | "error";
  scanned: number;
  total: number | null;
  startedAt: number;
  finishedAt: number | null;
  error?: string | null;
}

/** One entry in the integration catalog: what this build can connect, and
 *  what this vault has actually added. */
export interface Integration {
  id: SourceType;
  name: string;
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

export interface IntegrationStatus {
  /** Whether TG_API_ID / TG_API_HASH were supplied at all. Without them
   *  there is nothing to log in to, so the UI shows setup instructions
   *  rather than a login form. */
  configured: boolean;
  authorized: boolean;
}
