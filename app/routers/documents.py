import asyncio
from functools import lru_cache
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from .. import cache, jobs, store
from ..keywords import top_keywords
from ..models import Collection
from ..telegram_client import sync_channel

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
    scope = [
        (cid, channels_by_id[cid].allowedExtensions) for cid in node.channelIds if cid in channels_by_id
    ]
    limit = max(1, min(limit, 20))

    # Tokenizing every filename in a large collection takes ~0.1s, and this
    # endpoint fires on every collection navigation. Memoize on each
    # channel's fetched_at so the result is reused until a scan or refresh
    # actually changes the underlying names, and never goes stale.
    stamp = tuple((cid, tuple(exts), cache.get_fetched_at(cid)) for cid, exts in scope)
    return {"keywords": await asyncio.to_thread(_keywords_for, stamp, limit)}


@lru_cache(maxsize=64)
def _keywords_for(stamp: tuple, limit: int) -> List[dict]:
    scope = [(cid, list(exts)) for cid, exts, _ in stamp]
    return top_keywords(cache.iter_names(scope), limit)


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

    # Only talk to Telegram when there's a reason to: an explicit Refresh,
    # or a channel nobody has ever scanned. Otherwise this is a pure
    # database read.
    errors: List[str] = []
    for channel in bound_channels:
        if not (refresh or not cache.has_channel(channel.id)):
            continue
        try:
            await sync_channel(channel.id, channel.channel, force_refresh=refresh)
        except RuntimeError as e:
            errors.append(f"{channel.name}: {e}")

    scope = [(c.id, c.allowedExtensions) for c in bound_channels]
    offset = max(0, offset)
    limit = max(1, min(limit, 100))
    # Extension allowlist, substring search, ordering and paging all happen
    # in SQL — the router never holds more than one page of documents.
    page, total = await asyncio.to_thread(
        cache.query_documents, scope, search, sort, offset, limit
    )
    counts = cache.channel_counts(scope)

    if not total and errors:
        raise HTTPException(502, "; ".join(errors))

    return {
        "collection": node,
        "channels": [jobs.to_out(c, counts.get(c.id)) for c in bound_channels],
        "documents": page,
        "total": total,
        "offset": offset,
        "limit": limit,
        "errors": errors,
    }
