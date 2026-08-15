from typing import List, Optional

from fastapi import APIRouter, HTTPException

from .. import cache, store
from ..ext_filter import filter_by_extensions, filter_names_by_extensions
from ..keywords import top_keywords
from ..models import Collection
from ..telegram_client import list_documents

router = APIRouter(prefix="/api/collections", tags=["documents"])


def _find(nodes: List[Collection], collection_id: str) -> Optional[Collection]:
    for n in nodes:
        if n.id == collection_id:
            return n
        if n.children:
            found = _find(n.children, collection_id)
            if found:
                return found
    return None


@router.get("/{collection_id}/keywords")
async def get_keywords(collection_id: str, limit: int = 8):
    """Most-frequent words across this collection's cached filenames — the
    pill row under the search bar. Reads only the on-disk document cache
    (same source as the collection tree's fileCount), so this is instant
    and never triggers a live Telegram fetch; a channel that hasn't been
    scanned yet just contributes no words until the background refresh
    loop or a manual "Refresh" populates its cache entry."""
    collections = store.load_collections()
    node = _find(collections, collection_id)
    if not node:
        raise HTTPException(404, "Collection not found")
    if not node.channelIds:
        return {"keywords": []}

    channels_by_id = {c.id: c for c in store.load_channels()}
    names: List[str] = []
    for channel_id in node.channelIds:
        channel = channels_by_id.get(channel_id)
        if not channel:
            continue
        cached_names = cache.get_cached_names(channel.id)
        if not cached_names:
            continue
        names.extend(filter_names_by_extensions(cached_names, channel.allowedExtensions))

    limit = max(1, min(limit, 20))
    return {"keywords": top_keywords(names, limit)}


@router.get("/{collection_id}/documents")
async def get_documents(
    collection_id: str,
    search: Optional[str] = None,
    sort: str = "date_desc",
    refresh: bool = False,
    offset: int = 0,
    limit: int = 20,
):
    collections = store.load_collections()
    node = _find(collections, collection_id)
    if not node:
        raise HTTPException(404, "Collection not found")
    if not node.channelIds:
        raise HTTPException(400, "Collection is a container, not bound to any channel")

    channels_by_id = {c.id: c for c in store.load_channels()}
    bound_channels = [channels_by_id[cid] for cid in node.channelIds if cid in channels_by_id]
    if not bound_channels:
        raise HTTPException(409, "None of this collection's channels exist anymore — rebind it in Settings")

    docs = []
    errors: List[str] = []
    for channel in bound_channels:
        try:
            channel_docs = await list_documents(channel.id, channel.channel, force_refresh=refresh)
        except RuntimeError as e:
            errors.append(f"{channel.name}: {e}")
            continue
        channel_docs = filter_by_extensions(channel_docs, channel.allowedExtensions)
        for d in channel_docs:
            d.channelId = channel.id
        docs.extend(channel_docs)

    if not docs and errors:
        raise HTTPException(502, "; ".join(errors))

    if search:
        needle = search.lower()
        docs = [d for d in docs if needle in d.name.lower()]

    key_name, _, direction = sort.rpartition("_")
    reverse = direction != "asc"
    key_fn = {
        "date": lambda d: d.date,
        "name": lambda d: d.name.lower(),
        "size": lambda d: d.size,
    }.get(key_name, lambda d: d.date)
    docs = sorted(docs, key=key_fn, reverse=reverse)

    total = len(docs)
    offset = max(0, offset)
    limit = max(1, min(limit, 100))
    page = docs[offset : offset + limit]

    return {
        "collection": node,
        "channels": bound_channels,
        "documents": page,
        "total": total,
        "offset": offset,
        "limit": limit,
        "errors": errors,
    }
