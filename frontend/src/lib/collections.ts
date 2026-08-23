import type { Collection } from "../types";

export interface CollectionRef {
  id: string;
  name: string;
  /** Names from the root collection down to (and including) this one. */
  path: string[];
}

/** Invert the collection tree into `sourceId → collections bound to it`.
 *  A source can be bound at several places in the tree (and a collection
 *  can bind several sources), so this is many-to-many. Derived on the
 *  client from the tree the page already loads — there's no server-side
 *  reverse index. Ids are unique across source types, so one index covers
 *  channels and playlists alike. */
export function collectionsBySource(nodes: Collection[]): Record<string, CollectionRef[]> {
  const bySource: Record<string, CollectionRef[]> = {};

  function walk(list: Collection[], ancestors: string[]) {
    for (const node of list) {
      const path = [...ancestors, node.name];
      for (const sourceId of node.sourceIds) {
        (bySource[sourceId] ??= []).push({ id: node.id, name: node.name, path });
      }
      walk(node.children, path);
    }
  }

  walk(nodes, []);
  return bySource;
}

/** The chain of collections from the tree's root down to `id`, or null if
 *  it isn't in the tree — used to build a breadcrumb trail. */
export function findPath(nodes: Collection[], id: string, trail: Collection[] = []): Collection[] | null {
  for (const n of nodes) {
    const next = [...trail, n];
    if (n.id === id) return next;
    if (n.children.length) {
      const found = findPath(n.children, id, next);
      if (found) return found;
    }
  }
  return null;
}
