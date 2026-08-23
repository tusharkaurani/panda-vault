import asyncio
from functools import lru_cache
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from .. import cache, jobs, m3u, sources, store, telegram_client
from ..keywords import top_keywords
from ..models import M3U, TELEGRAM, Collection
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
    if not node.sourceIds:
        return {"keywords": []}

    scope = sources.scope(sources.bound(node, sources.load_by_id(node.sourceType)))
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


async def _sync_bound(bound, source_type, refresh: bool) -> List[str]:
    """Bring the bound sources up to date before reading, returning one
    human-readable line per source that couldn't be reached.

    Only talks to the network when there's a reason to: an explicit
    Refresh, or a source nobody has ever scanned. Otherwise this is a pure
    database read.
    """
    errors: List[str] = []

    if source_type == M3U:
        for playlist in bound:
            if not (refresh or not cache.has_source(playlist.id)):
                continue
            try:
                await m3u.sync_playlist(playlist.id, playlist.url, force_refresh=refresh)
            except RuntimeError as e:
                errors.append(f"{playlist.name}: {e}")
        return errors

    # Telegram is optional now, so a logged-out install still has to be able
    # to browse what it scanned earlier — serve the cached rows and say why
    # they might be stale, rather than failing the whole collection.
    if not await telegram_client.is_authorized():
        if refresh:
            errors.append(
                "Telegram is not connected — showing what was cached. Connect it in Settings."
            )
        return errors

    for channel in bound:
        if not (refresh or not cache.has_source(channel.id)):
            continue
        try:
            await sync_channel(channel.id, channel.channel, force_refresh=refresh)
        except RuntimeError as e:
            errors.append(f"{channel.name}: {e}")
    return errors


@router.get("/{collection_id}/health")
async def get_collection_health(collection_id: str):
    """Just this collection's reachability tallies.

    Split out from the documents endpoint so a page can follow a running
    stream check without re-requesting the documents themselves — which
    would replace an infinite-scrolled list with its first page and throw
    away the reader's position every few seconds.
    """
    node = _find(store.load_collections(), collection_id)
    if not node:
        raise HTTPException(404, "Collection not found")
    if node.sourceType != M3U or not node.sourceIds:
        return {"healthTotals": {}}
    scope = sources.scope(sources.bound(node, sources.load_by_id(node.sourceType)))
    return {"healthTotals": await asyncio.to_thread(cache.stream_health_summary, scope)}


@router.get("/{collection_id}/groups")
async def get_collection_groups(
    collection_id: str,
    search: Optional[str] = None,
    refresh: bool = False,
    health: Optional[str] = None,
):
    """The Grouped view's overview: one card per category with a real count,
    honoring the same search/health filters `/documents` would. Split out
    rather than folded into `/documents` because a category listing is a
    different query shape (GROUP BY, not LIMIT/OFFSET) that would otherwise
    run on every documents call regardless of which view mode asked for it.
    """
    collections = store.load_collections()
    node = _find(collections, collection_id)
    if not node:
        raise HTTPException(404, "Collection not found")
    if not node.sourceIds:
        raise HTTPException(400, "Collection is a container, not bound to any source")

    bound = sources.bound(node, sources.load_by_id(node.sourceType))
    if not bound:
        raise HTTPException(409, "None of this collection's sources exist anymore — rebind it in Settings")

    errors: List[str] = await _sync_bound(bound, node.sourceType, refresh)
    scope = sources.scope(bound)
    rows = await asyncio.to_thread(cache.list_groups, scope, search, health)
    counts = cache.source_counts(scope)
    health_totals = (
        await asyncio.to_thread(cache.stream_health_summary, scope)
        if node.sourceType == M3U
        else {}
    )

    if not rows and errors:
        raise HTTPException(502, "; ".join(errors))

    return {
        "collection": node,
        "sources": [jobs.to_source_out(s, node.sourceType, counts.get(s.id)) for s in bound],
        "groups": [{"name": name, "count": entry_count} for name, entry_count in rows],
        "errors": errors,
        "healthTotals": health_totals,
    }


@router.get("/{collection_id}/documents")
async def get_documents(
    collection_id: str,
    search: Optional[str] = None,
    sort: str = "date_desc",
    refresh: bool = False,
    offset: int = 0,
    limit: int = 20,
    health: Optional[str] = None,
    group: Optional[str] = None,
):
    collections = store.load_collections()
    node = _find(collections, collection_id)
    if not node:
        raise HTTPException(404, "Collection not found")
    if not node.sourceIds:
        raise HTTPException(400, "Collection is a container, not bound to any source")

    bound = sources.bound(node, sources.load_by_id(node.sourceType))
    if not bound:
        raise HTTPException(409, "None of this collection's sources exist anymore — rebind it in Settings")

    errors: List[str] = await _sync_bound(bound, node.sourceType, refresh)
    scope = sources.scope(bound)
    offset = max(0, offset)
    limit = max(1, min(limit, 100))
    # Extension allowlist, substring search, ordering and paging all happen
    # in SQL — the router never holds more than one page of documents.
    page, total = await asyncio.to_thread(
        cache.query_documents, scope, search, sort, offset, limit, health, group
    )
    counts = cache.source_counts(scope)
    # What the health filter's options should be labelled with. Only streams
    # have a reachability state, so a Telegram collection doesn't pay for it.
    health_totals = (
        await asyncio.to_thread(cache.stream_health_summary, scope)
        if node.sourceType == M3U
        else {}
    )

    if not total and errors:
        raise HTTPException(502, "; ".join(errors))

    return {
        "collection": node,
        "sources": [jobs.to_source_out(s, node.sourceType, counts.get(s.id)) for s in bound],
        "documents": page,
        "total": total,
        "offset": offset,
        "limit": limit,
        "errors": errors,
        "healthTotals": health_totals,
    }
