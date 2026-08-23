import asyncio
from typing import Dict, List

from fastapi import APIRouter, Query

from .. import cache, sources, store
from ..models import Collection

router = APIRouter(prefix="/api/search", tags=["search"])


def _walk_bound_collections(nodes: List[Collection]):
    for n in nodes:
        if n.sourceIds:
            yield n
        if n.children:
            yield from _walk_bound_collections(n.children)


@router.get("")
async def search(q: str = Query(..., min_length=2), offset: int = 0, limit: int = 20):
    """Substring search over every item in every collection-bound source.

    Spans every integration at once — Telegram documents and M3U entries
    come back interleaved in one page, each row carrying the sourceType it
    takes to render and link it. That stays a single SQL query because the
    cache partitions by source id without caring which kind it is.

    Returns one page of results, each carrying only the ids and names it
    takes to render a row. It used to embed the matching document's whole
    `Collection` (recursively, children and all) plus its `Channel`, once
    per result, with no limit at all — a single-character query returned
    ~116k results as a 68MB response.

    A source bound to more than one collection is searched once and
    attributed to the first collection that binds it in tree order, so it
    can no longer produce duplicate rows for the same document.

    Reads only the document cache, so it never triggers a scan: an
    unscanned source contributes nothing here until the background refresh
    loop or a manual Rebuild fills it in.
    """
    collections = store.load_collections()
    all_sources = sources.load_all_by_id()

    owner: Dict[str, Collection] = {}
    for node in _walk_bound_collections(collections):
        for source_id in node.sourceIds:
            if source_id in all_sources:
                owner.setdefault(source_id, node)

    scope = [(sid, all_sources[sid].allowedExtensions) for sid in owner]
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
                "collectionId": owner[d.sourceId].id,
                "collectionName": owner[d.sourceId].name,
                "sourceId": d.sourceId,
                "sourceName": all_sources[d.sourceId].name,
                "sourceType": d.sourceType,
                "document": d,
            }
            for d in docs
        ],
    }
