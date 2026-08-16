import type { Collection } from "../types";

export interface CollectionRef {
  id: string;
  name: string;
  /** Names from the root collection down to (and including) this one. */
  path: string[];
}

/** Invert the collection tree into `channelId → collections bound to it`.
 *  A channel can be bound at several places in the tree (and a collection
 *  can bind several channels), so this is many-to-many. Derived on the
 *  client from the tree the page already loads — there's no server-side
 *  reverse index. */
export function collectionsByChannel(nodes: Collection[]): Record<string, CollectionRef[]> {
  const byChannel: Record<string, CollectionRef[]> = {};

  function walk(list: Collection[], ancestors: string[]) {
    for (const node of list) {
      const path = [...ancestors, node.name];
      for (const channelId of node.channelIds) {
        (byChannel[channelId] ??= []).push({ id: node.id, name: node.name, path });
      }
      walk(node.children, path);
    }
  }

  walk(nodes, []);
  return byChannel;
}
