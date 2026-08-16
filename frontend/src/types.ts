export type ChannelStatus =
  | "ready"
  | "scanning"
  | "rebuilding"
  | "unscanned"
  | "empty"
  | "error"
  | "not_joined";

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

export interface Collection {
  id: string;
  name: string;
  description: string;
  icon?: string | null;
  channelIds: string[];
  children: Collection[];
  fileCount?: number;
  folderCount?: number;
}

export interface DocumentOut {
  id: number;
  name: string;
  size: number;
  size_human: string;
  date: string;
  mime_type?: string | null;
  channelId?: string | null;
}

export interface DocumentsResponse {
  collection: Collection;
  channels: Channel[];
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
  channelId: string;
  channelName: string;
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
  channelId: string;
  channelName: string;
  kind: "scan" | "rebuild";
  status: "running" | "done" | "error";
  scanned: number;
  total: number | null;
  startedAt: number;
  finishedAt: number | null;
  error?: string | null;
}
