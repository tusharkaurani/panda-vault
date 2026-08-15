export interface Channel {
  id: string;
  name: string;
  description: string;
  channel: string;
  joined: boolean;
  allowedExtensions: string[];
  created_at: number;
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

export interface SearchResult {
  collection: Collection;
  channel: Channel;
  document: DocumentOut;
}

export interface KeywordCount {
  word: string;
  count: number;
}

export interface RebuildJob {
  id: string;
  channelId: string;
  channelName: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  error?: string | null;
}
