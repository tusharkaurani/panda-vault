import asyncio
from typing import Dict, List

from fastapi import APIRouter, Query

from .. import cache, store
from ..models import Collection

router = APIRouter(prefix="/api/search", tags=["search"])


def _walk_channel_collections(nodes: List[Collection]):
    for n in nodes:
        if n.channelIds:
            yield n
        if n.children:
            yield from _walk_channel_collections(n.children)


@router.get("")
async def search(q: str = Query(..., min_length=2), offset: int = 0, limit: int = 20):
    """Substring search over every document in every collection-bound channel.

    Returns one page of results, each carrying only the ids and names it
    takes to render a row. It used to embed the matching document's whole
    `Collection` (recursively, children and all) plus its `Channel`, once
    per result, with no limit at all — a single-character query returned
    ~116k results as a 68MB response.

    A channel bound to more than one collection is searched once and
    attributed to the first collection that binds it in tree order, so it
    can no longer produce duplicate rows for the same document.

    Reads only the document cache, so it never triggers a Telegram scan:
    an unscanned channel contributes nothing here until the background
    refresh loop or a manual Rebuild fills it in.
    """
    collections = store.load_collections()
    channels = {c.id: c for c in store.load_channels()}

    owner: Dict[str, Collection] = {}
    for node in _walk_channel_collections(collections):
        for channel_id in node.channelIds:
            if channel_id in channels:
                owner.setdefault(channel_id, node)

    scope = [(cid, channels[cid].allowedExtensions) for cid in owner]
    offset = max(0, offset)
    limit = max(1, min(limit, 100))
    docs, total = await asyncio.to_thread(cache.query_documents, scope, q, "date_desc", offset, limit)

    return {
        "query": q,
        "total": total,
        "offset": offset,
        "limit": limit,
        "results": [
            {
                "collectionId": owner[d.channelId].id,
                "collectionName": owner[d.channelId].name,
                "channelId": d.channelId,
                "channelName": channels[d.channelId].name,
                "document": d,
            }
            for d in docs
        ],
    }
